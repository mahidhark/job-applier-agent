/**
 * Ranking, over postings that already cleared the gates.
 *
 * Pure functions, no network, no database. Gates decide whether to pursue a
 * role; scoring decides which to work on first, because writing a good note
 * costs real attention and there are more qualifying roles than hours.
 */
import type { JobPosting } from '../sources/types.js';
import type { ScoreConfig, ScreenConfig } from '../config-file.js';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const norm = (s: string) => s.toLowerCase();

export interface ScoreBreakdown {
  total: number;
  parts: Record<string, number>;
  matched: string[];
}

/** A named seniority in the title beats a generic one. */
function titleFit(title: string, wanted: string[]): number {
  const t = norm(title);
  const senior = /\b(senior|lead|principal|head of|director|staff|group)\b/.test(t);
  const matched = wanted.some((w) => t.includes(norm(w)));
  if (!matched) return 0;
  return senior ? 1 : 0.6;
}

export function scoreJob(
  job: JobPosting,
  now: Date,
  score: ScoreConfig,
  screen: ScreenConfig,
): ScoreBreakdown {
  const hay = norm(`${job.title} ${job.department ?? ''} ${job.description}`);
  const matched = screen.skills.filter((s) => hay.includes(norm(s)));

  const parts: Record<string, number> = {
    titleFit: titleFit(job.title, screen.titleMustMatch),
    // Three distinct signals is a strong match; more adds little.
    skillOverlap: clamp01(matched.length / 3),
    companyStage: (() => {
      const n = job.companySize;
      if (n == null) return 0.5; // unknown, not bad
      const { min, max } = score.companySizeSweetSpot;
      if (n >= min && n <= max) return 1;
      return n < min ? 0.6 : clamp01(max / n);
    })(),
    freshness: (() => {
      if (!job.postedAt) return 0.5;
      const days = (now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000;
      return clamp01(1 - days / score.freshnessFloorDays);
    })(),
    // The whole strategy rests on reaching a named human. A posting that
    // already tells us who posted it is worth more than one that does not.
    contactability: job.contactProfileUrl ? 1 : job.companyLinkedinUrl ? 0.5 : 0.2,
  };

  let total = 0;
  for (const [k, w] of Object.entries(score.weights)) total += (parts[k] ?? 0) * w;

  return { total: Math.round(total * 1000) / 10, parts, matched };
}
