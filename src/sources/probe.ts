/**
 * Check every configured board actually answers, without spending anything.
 *
 *   npm run sources
 *
 * Board slugs rot: a company migrates ATS, renames its board, or goes quiet.
 * This tells you which, in one call each, before a poll silently returns less
 * than it should.
 */
import { loadConfig } from '../config-file.js';
import { buildAtsSources } from './ats/index.js';

async function main() {
  const config = loadConfig();
  const sources = buildAtsSources(config.boards);
  console.log(`\n  probing ${sources.length} boards\n`);

  for (const [i, source] of sources.entries()) {
    const board = config.boards[i]!;
    const started = Date.now();
    try {
      const jobs = await source.fetch();
      const ms = Date.now() - started;
      console.log(`  ok    ${board.company.padEnd(18)} ${board.ats}/${board.slug} — ${jobs.length} postings (${ms}ms)`);
    } catch (err) {
      console.log(`  FAIL  ${board.company.padEnd(18)} ${board.ats}/${board.slug} — ${(err as Error).message}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
