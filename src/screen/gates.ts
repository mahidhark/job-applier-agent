/**
 * Hard eligibility gates.
 *
 * Every gate is a REJECT, not a warning — with a queue nobody reads, an
 * advisory flag is a log line that goes nowhere. `passed()` is an AND.
 *
 * One deliberate exception to "a missing field is a rejection": several boards
 * publish no salary and no posting date at all, so gating on their absence
 * would reject every Greenhouse role on principle. Where absence is genuinely
 * uninformative the gate passes and says so; where absence means the posting is
 * unusable, it rejects. Each gate states which it is.
 */
import type { JobPosting } from '../sources/types.js';
import type { ScreenConfig } from '../config-file.js';

export interface GateOutcome {
  gate: string;
  passed: boolean;
  detail: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Countries the operator can legally and practically work from. */
function locationOk(job: JobPosting, config: ScreenConfig): { ok: boolean; detail: string } {
  const text = norm(`${job.location ?? ''} ${job.remote ? 'remote' : ''}`);
  if (!text) return { ok: true, detail: 'no location stated' };

  const home = norm(config.operatorCountry);
  if (text.includes(home)) return { ok: true, detail: `matches ${config.operatorCountry}` };

  const accepted = config.acceptRemoteIn.find((r) => text.includes(norm(r)));
  if (accepted) return { ok: true, detail: `remote scope "${accepted}"` };

  // A board that writes "Utrecht" never adds "Netherlands", so a home-country
  // city has to be recognised by name. Everything else is rejected.
  //
  // This direction is deliberate. An earlier version passed any short bare
  // locality as "country unknown", which let 3,084 Bjak postings across every
  // Asian market through on the first live run. When a board states a location
  // at all it is telling you something; failing to recognise it as home is
  // evidence against, not neutral.
  const local = config.homeLocalities.find((c) => text.includes(norm(c)));
  if (local) return { ok: true, detail: `${local} is in ${config.operatorCountry}` };

  return { ok: false, detail: `"${job.location}" is not in ${config.operatorCountry}` };
}

export function screen(job: JobPosting, now: Date, config: ScreenConfig): GateOutcome[] {
  const out: GateOutcome[] = [];
  const add = (gate: string, passed: boolean, detail: string) => out.push({ gate, passed, detail });

  const title = norm(job.title);

  // --- the role must be one we want. Both directions, because "Product
  //     Marketing Manager" matches "product manager" as a substring.
  const wanted = config.titleMustMatch.find((t) => title.includes(norm(t)));
  const banned = config.titleMustNotMatch.find((t) => title.includes(norm(t)));
  add('title_wanted', Boolean(wanted), wanted ? `matches "${wanted}"` : `"${job.title}" matches no wanted title`);
  add('title_not_excluded', !banned, banned ? `matches excluded "${banned}"` : 'not excluded');

  // --- location.
  const loc = locationOk(job, config);
  add('location_eligible', loc.ok, loc.detail);

  // --- freshness, as an outlier check only.
  //
  // This is deliberately loose. On a freelance marketplace, age decides your
  // position in the queue and a stale posting is a lost bid. A permanent role
  // open for three months just means they have not found anyone — which is
  // information in your favour, not against. Two live Skydreams roles at 59
  // and 86 days were still open and still worth applying to; a 30-day gate
  // rejected both. Freshness belongs in scoring, where it nudges ordering,
  // and the gate exists only to drop postings a board forgot to close.
  //
  // A null date is unknown rather than stale: Lever and Ashby both omit it.
  if (job.postedAt) {
    const ageDays = (now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000;
    add('fresh', ageDays <= config.maxAgeDays, `${Math.round(ageDays)} days old, window ${config.maxAgeDays}`);
  } else {
    add('fresh', true, 'no posting date published');
  }

  // --- pay. Most boards publish nothing, so absence passes. When a number IS
  //     published and it is below the floor, that is a real answer.
  if (job.salaryMax != null || job.salaryMin != null) {
    const top = job.salaryMax ?? job.salaryMin ?? 0;
    add('pay_acceptable', top >= config.minSalary,
      `${config.salaryCurrency} ${top} against floor ${config.minSalary}`);
  } else {
    add('pay_acceptable', true, 'no salary published');
  }

  // --- relevance. Title and description, because unlike a marketplace posting
  //     a job ad's body is written by the hiring team and is not adversarial.
  const hay = norm(`${job.title} ${job.department ?? ''} ${job.description}`);
  const hits = config.skills.filter((s) => hay.includes(norm(s)));
  add('relevant', hits.length >= config.minSkillMatches,
    hits.length ? `matches ${hits.slice(0, 6).join(', ')}` : 'matches nothing in the skill list');

  return out;
}

export const passed = (o: GateOutcome[]): boolean => o.every((g) => g.passed);
export const failures = (o: GateOutcome[]): GateOutcome[] => o.filter((g) => !g.passed);
