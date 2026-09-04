/**
 * What the grouping actually did.
 *
 *   npm run roles              show every role and the listings under it
 *   npm run roles -- --backfill  group postings that predate grouping
 *   npm run roles -- --judge     DRY RUN: what a model would group differently
 *   npm run roles -- --taxonomy  DRY RUN: what brands each company runs
 *   npm run roles -- --learn     derive and SAVE those taxonomies, then regroup
 *
 * This exists because a group is a HYPOTHESIS. "AI Finance App" and "AI Neobank
 * App" at one company might be one job advertised twice or two teams with two
 * managers, and no title tells you which. Grouping without a way to read the
 * groups would mean quietly hiding opportunities and never finding out.
 */
import {
  q, run, upsertRole, setRoleId, setState, postingsInRole, taxonomyFor, saveTaxonomy,
  recordDecision, type Role,
} from './store/db.js';
import { roleKey, roleCore, qualifierOf } from './roles/key.js';
import { judgeCandidate, type CandidatePosting } from './roles/judge.js';
import {
  deriveTaxonomy, unitFor, taxonomyFromStore, slugifyUnit, type TaxonomyPosting, type Taxonomy,
} from './roles/taxonomy.js';
import { loadConfig } from './config-file.js';

const args = process.argv.slice(2);

/**
 * Group postings that were stored before grouping existed.
 *
 * Only live states. The 3,001 rejected rows were decided weeks ago and nothing
 * reads them again, so tagging them would be work with no reader — and leave
 * more to undo if this is reverted.
 *
 * Idempotent: role ids are the role key, so a second run inserts nothing new.
 */
function backfill(): void {
  const rows = q<{ id: string; company: string; title: string; state: string; posted_at: string | null; score: number | null }>(
    `SELECT id, company, title, state, posted_at, score FROM jobs
      WHERE state IN ('scored', 'enriched', 'queued', 'variant') ORDER BY id`,
  );
  if (!rows.length) {
    console.log('\n  Nothing in a live state to group.\n');
    return;
  }

  // The unit for each posting, from whatever the store already knows. A
  // company with no recorded taxonomy gets a single unit, which reproduces the
  // pre-taxonomy grouping exactly — so running this on an untaxonomised store
  // is a no-op rather than a reshuffle.
  const taxonomies = new Map<string, Taxonomy>();
  const taxonomyOf = (company: string): Taxonomy => {
    const key = company.toLowerCase();
    let t = taxonomies.get(key);
    if (!t) { t = taxonomyFromStore(taxonomyFor(key)); taxonomies.set(key, t); }
    return t;
  };

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = roleKey(r.company, unitFor(taxonomyOf(r.company), qualifierOf(r.title)), r.title);
    const bucket = groups.get(key);
    if (bucket) bucket.push(r); else groups.set(key, [r]);
  }

  // Picking a representative is part of the backfill, not a later step.
  //
  // `poll` only ever judges postings it has not seen before, so a re-run will
  // not revisit these 38 rows. Tagging them without choosing a representative
  // would leave every Bjak listing still competing for a queue slot, which is
  // the entire problem this is meant to solve.
  let tagged = 0, demoted = 0;
  for (const [key, members] of groups) {
    const unit = unitFor(taxonomyOf(members[0]!.company), qualifierOf(members[0]!.title));
    upsertRole(key, members[0]!.company, key, roleCore(members[0]!.title), unit);

    // Work already started outranks anything: a posting that has been queued
    // or sent is the one the operator has in hand, and demoting it would
    // orphan that work. Otherwise freshest, best scored, lowest id — the same
    // rule poll.ts uses, and the last term keeps the choice stable.
    const rank = (st: string) => (st === 'sent' ? 0 : st === 'queued' ? 1 : st === 'enriched' ? 2 : 3);
    const ranked = [...members].sort((a, b) => {
      if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state);
      const at = a.posted_at ? Date.parse(a.posted_at) : 0;
      const bt = b.posted_at ? Date.parse(b.posted_at) : 0;
      if (at !== bt) return bt - at;
      if ((a.score ?? 0) !== (b.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
      return a.id < b.id ? -1 : 1;
    });

    for (const [i, m] of ranked.entries()) {
      setRoleId(m.id, key);
      tagged++;
      if (i === 0) {
        // Leave the representative's state alone. It may be `queued` or `sent`,
        // and nothing here has the standing to undo that.
        if (m.state === 'variant') setState(m.id, 'scored');
      } else if (m.state !== 'sent') {
        // Count every posting that ends up a variant, not only the ones this
        // run changed. A re-run otherwise reports "0 became variants" while 26
        // of them are, which reads as the grouping having done nothing.
        if (m.state !== 'variant') setState(m.id, 'variant');
        demoted++;
      }
    }
  }
  // FINDING 7.b. `contacts.role_id` was written when role ids had two
  // segments. Re-keying the roles without remapping it detaches a contact from
  // its role silently — and a contact is a paid artefact, so that failure is
  // both expensive and invisible.
  const remapped = q<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contacts
      WHERE EXISTS (SELECT 1 FROM jobs WHERE jobs.id = contacts.job_id)
        AND (role_id IS NULL
             OR role_id != (SELECT role_id FROM jobs WHERE jobs.id = contacts.job_id))`,
  )[0]?.n ?? 0;
  run(`UPDATE contacts SET role_id = (SELECT role_id FROM jobs WHERE jobs.id = contacts.job_id)
       WHERE EXISTS (SELECT 1 FROM jobs WHERE jobs.id = contacts.job_id)`);

  // Roles nothing points at any more, left over from an earlier key shape.
  const orphans = q<{ n: number }>(
    'SELECT COUNT(*) AS n FROM roles WHERE id NOT IN (SELECT DISTINCT role_id FROM jobs WHERE role_id IS NOT NULL)',
  )[0]?.n ?? 0;
  run('DELETE FROM roles WHERE id NOT IN (SELECT DISTINCT role_id FROM jobs WHERE role_id IS NOT NULL)');

  console.log(`\n  ${tagged} live posting(s) grouped into ${groups.size} role(s).`);
  console.log(`  ${demoted} are further listings of a role already kept.`);
  if (remapped) console.log(`  ${remapped} contact(s) re-pointed at their new role.`);
  if (orphans) console.log(`  ${orphans} role(s) from the old key shape removed.`);
  console.log('  Read them with `npm run roles`.\n');
}

/**
 * Derive and SAVE a taxonomy for every company, then regroup.
 *
 * The writing counterpart of --taxonomy. Separate from --backfill because it
 * spends money and --backfill does not, and because a stored taxonomy is a
 * durable judgement that should be made deliberately.
 */
async function learnTaxonomies(): Promise<void> {
  const config = loadConfig();
  const companies = q<{ company: string }>(
    `SELECT DISTINCT company FROM jobs WHERE state != 'rejected' ORDER BY company`,
  );

  for (const { company } of companies) {
    const rows = q<{ title: string; raw: string }>(
      `SELECT title, raw FROM jobs WHERE company = ? AND state != 'rejected'`, company,
    );
    const postings: TaxonomyPosting[] = rows.map((r) => ({
      title: r.title,
      qualifier: qualifierOf(r.title),
      description: (JSON.parse(r.raw) as { description?: string }).description ?? '',
    }));

    process.stdout.write(`  ${company} ... `);
    try {
      const tax = await deriveTaxonomy(company, postings, config.ai);
      saveTaxonomy(company.toLowerCase(), tax.units.map((u) => ({
        slug: slugifyUnit(u.name),
        name: u.name,
        description: u.description,
        evidence: u.evidence,
        qualifiers: Object.entries(tax.assignment)
          .filter(([, name]) => name.toLowerCase() === u.name.toLowerCase())
          .map(([qual]) => qual),
      })));
      recordDecision({
        kind: 'taxonomy', subject: company.toLowerCase(),
        context: { qualifiers: Object.keys(tax.assignment) },
        chose: { units: tax.units.map((u) => u.name), assignment: tax.assignment },
        reasoning: tax.units.map((u) => `${u.name}: ${u.description}`).join(' | '),
        decider: tax.decider,
      });
      console.log(`${tax.units.length} unit(s): ${tax.units.map((u) => u.name).join(', ')}`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  console.log('\n  Taxonomies saved. Regrouping...');
  backfill();
}

function list(): void {
  const roles = q<Role & { unit: string | null }>(
    'SELECT * FROM roles ORDER BY company, unit, role_key',
  );
  // FINDING 7.d — a human reads the brand name, never the slug that went into
  // the id. "kira-superapp" is an implementation detail; "KIRA Superapp" is
  // the thing they would recognise on a careers page.
  const displayName = new Map<string, string>();
  for (const u of q<{ company: string; slug: string; name: string }>(
    'SELECT company, slug, name FROM company_units',
  )) displayName.set(`${u.company}::${u.slug}`, u.name);
  if (!roles.length) {
    console.log('\n  No roles yet. Run `npm run poll -- --once`, or `npm run roles -- --backfill`.\n');
    return;
  }

  console.log(`\n  ${roles.length} role(s)\n`);
  for (const role of roles) {
    const postings = postingsInRole(role.id);
    const live = postings.filter((p) => p.state !== 'rejected');
    const brand = displayName.get(`${role.company.toLowerCase()}::${role.unit ?? ''}`);
    console.log('─'.repeat(74));
    console.log(`  ${role.company}${brand && brand !== 'default' ? ` (${brand})` : ''} — ${role.title}`);
    console.log(`  ${live.length} listing${live.length === 1 ? '' : 's'}`);

    for (const p of postings) {
      const mark = p.state === 'scored' ? '→' : ' ';
      const qual = qualifierOf(p.title);
      console.log(
        `   ${mark} ${(p.score ?? 0).toFixed(1).padStart(5)}  ${qual || '(no qualifier)'}` +
        `${p.location ? `  · ${p.location}` : ''}${p.state === 'scored' ? '' : `  [${p.state}]`}`,
      );
    }
    console.log('');
  }
  console.log('  → marks the listing that represents the role. The rest are the same job,');
  console.log('    advertised again. If a group looks wrong, say so — the key is one file.\n');
}

/**
 * Dry run: ask the judge, print the difference, write nothing.
 *
 * This is the gate the v2.0 plan is waiting on. Its central assumption —
 * that the DESCRIPTIONS distinguish Homedeal from Moving24 where the titles
 * cannot — is unverified. If they do not, the plan is wrong, and this is much
 * cheaper than finding out after it is wired into the poll.
 */
async function dryRun(): Promise<void> {
  const config = loadConfig();
  const roles = q<Role>('SELECT * FROM roles ORDER BY company, role_key');
  if (!roles.length) {
    console.log('\n  No roles yet. Run `npm run roles -- --backfill` first.\n');
    return;
  }

  console.log(`\n  DRY RUN — nothing is written.\n  judge: ${config.ai.tasks?.judge ?? config.ai.provider}\n`);
  let agreed = 0, differed = 0;

  for (const role of roles) {
    const rows = q<{ id: string; title: string; raw: string }>(
      `SELECT id, title, raw FROM jobs WHERE role_id = ? AND state != 'rejected' ORDER BY id`,
      role.id,
    );
    if (rows.length < 2) continue;

    const postings: CandidatePosting[] = rows.map((r) => ({
      jobId: r.id,
      title: r.title,
      qualifier: qualifierOf(r.title),
      description: (JSON.parse(r.raw) as { description?: string }).description ?? '',
    }));

    process.stdout.write(`  ${role.company} — ${role.title} (${postings.length}) ... `);
    let judged;
    try {
      judged = await judgeCandidate(role.company, role.id, postings, config.ai);
    } catch (err) {
      console.log(`JUDGE FAILED: ${(err as Error).message.slice(0, 90)}`);
      continue;
    }

    const same = judged.groups.length === 1;
    if (same) { agreed++; console.log('one role — agrees with the key'); }
    else { differed++; console.log(`SPLITS INTO ${judged.groups.length}`); }

    for (const g of judged.groups) {
      const quals = g.jobIds
        .map((id) => postings.find((p) => p.jobId === id))
        .map((p) => qualifierOf(p?.title ?? '') || '(none)');
      console.log(`      ${g.confident ? '✓' : '?'} ${g.roleTitle}  [${quals.join(', ')}]`);
      console.log(`        ${g.reasoning.slice(0, 150)}`);
    }
    if (judged.priorCorrections) {
      console.log(`      (informed by ${judged.priorCorrections} prior correction(s))`);
    }
    console.log('');
  }

  console.log(`  ${agreed} group(s) the judge would keep, ${differed} it would split.`);
  console.log('  Nothing was written. Compare against `npm run roles` before wiring this in.\n');
}

/**
 * Dry run for the taxonomy pass. Writes nothing.
 *
 * The gate v2.1 is waiting on. Its central assumption is that ONE description
 * excerpt per distinct qualifier is enough to see a company's brands. If it is
 * not, this is where that shows — and it is far cheaper than finding out after
 * role ids have been rebuilt around it.
 */
async function taxonomyDryRun(): Promise<void> {
  const config = loadConfig();
  const companies = q<{ company: string }>(
    `SELECT DISTINCT company FROM jobs WHERE state != 'rejected' ORDER BY company`,
  );
  if (!companies.length) {
    console.log('\n  Nothing live to derive a taxonomy from.\n');
    return;
  }

  console.log(`\n  DRY RUN — nothing is written.\n  judge: ${config.ai.tasks?.judge ?? config.ai.provider}\n`);

  for (const { company } of companies) {
    const rows = q<{ title: string; raw: string }>(
      `SELECT title, raw FROM jobs WHERE company = ? AND state != 'rejected'`, company,
    );
    const postings: TaxonomyPosting[] = rows.map((r) => ({
      title: r.title,
      qualifier: qualifierOf(r.title),
      description: (JSON.parse(r.raw) as { description?: string }).description ?? '',
    }));

    process.stdout.write(`  ${company} — ${postings.length} listing(s) ... `);
    let tax;
    try {
      tax = await deriveTaxonomy(company, postings, config.ai);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message.slice(0, 90)}`);
      continue;
    }

    console.log(`${tax.units.length} unit(s)${tax.attempts > 1 ? `, asked ${tax.attempts}x` : ''}`);
    for (const u of tax.units) {
      const quals = Object.entries(tax.assignment)
        .filter(([, name]) => name.toLowerCase() === u.name.toLowerCase())
        .map(([qual]) => qual);
      console.log(`      ${u.name}  —  ${u.description}`);
      console.log(`        evidence: "${u.evidence.slice(0, 110)}"`);
      console.log(`        ${quals.join(', ') || '(nothing assigned)'}`);
    }

    // What the role ids would become. This is the part worth reading.
    const roleIds = new Set(
      rows.map((r) => `${company.toLowerCase()}::${unitFor(tax, qualifierOf(r.title))}::${roleCore(r.title).toLowerCase()}`),
    );
    console.log(`      -> ${roleIds.size} role(s) under this taxonomy\n`);
  }
  console.log('  Nothing was written. Compare against `npm run roles`.\n');
}

if (args.includes('--backfill')) backfill();
else if (args.includes('--judge')) await dryRun();
else if (args.includes('--taxonomy')) await taxonomyDryRun();
else if (args.includes('--learn')) await learnTaxonomies();
else list();
