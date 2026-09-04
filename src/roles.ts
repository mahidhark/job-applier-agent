/**
 * What the grouping actually did.
 *
 *   npm run roles              show every role and the listings under it
 *   npm run roles -- --backfill  group postings that predate grouping
 *   npm run roles -- --judge     DRY RUN: what a model would group differently
 *   npm run roles -- --taxonomy  DRY RUN: what brands each company runs
 *
 * This exists because a group is a HYPOTHESIS. "AI Finance App" and "AI Neobank
 * App" at one company might be one job advertised twice or two teams with two
 * managers, and no title tells you which. Grouping without a way to read the
 * groups would mean quietly hiding opportunities and never finding out.
 */
import { q, upsertRole, setRoleId, setState, postingsInRole, type Role } from './store/db.js';
import { roleKey, roleCore, qualifierOf } from './roles/key.js';
import { judgeCandidate, type CandidatePosting } from './roles/judge.js';
import { deriveTaxonomy, unitFor, type TaxonomyPosting } from './roles/taxonomy.js';
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

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = roleKey(r.company, r.title);
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
    upsertRole(key, members[0]!.company, key, roleCore(members[0]!.title));

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
      } else if (m.state !== 'sent' && m.state !== 'variant') {
        setState(m.id, 'variant');
        demoted++;
      }
    }
  }
  console.log(`\n  ${tagged} live posting(s) grouped into ${groups.size} role(s).`);
  console.log(`  ${demoted} became variants of a role already kept.`);
  console.log('  Read them with `npm run roles`.\n');
}

function list(): void {
  const roles = q<Role>('SELECT * FROM roles ORDER BY company, role_key');
  if (!roles.length) {
    console.log('\n  No roles yet. Run `npm run poll -- --once`, or `npm run roles -- --backfill`.\n');
    return;
  }

  console.log(`\n  ${roles.length} role(s)\n`);
  for (const role of roles) {
    const postings = postingsInRole(role.id);
    const live = postings.filter((p) => p.state !== 'rejected');
    console.log('─'.repeat(74));
    console.log(`  ${role.company} — ${role.title}`);
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
else list();
