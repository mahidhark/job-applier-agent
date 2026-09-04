/**
 * What is wired, and what each connection would give the agent.
 *
 *   npm run connections                 as configured
 *   npm run connections -- --profile narrow
 *
 * Live: it connects and lists the tools the servers actually expose, so a
 * profile that names an actor which no longer exists shows up here rather than
 * mid-run.
 */
import { resolveConnections, listToolProfiles } from './connections.js';
import { mcpTools, closeMcp } from './mcp.js';

const args = process.argv.slice(2);
const i = args.indexOf('--profile');
const profile = i >= 0 ? args[i + 1] : undefined;

async function main() {
  console.log('\n  TOOL PROFILES\n');
  for (const [name, p] of Object.entries(listToolProfiles())) {
    const mark = name === profile ? '→' : ' ';
    console.log(`  ${mark} ${name.padEnd(11)} ${p.tools.length || 'server default'} tools`);
    console.log(`      ${p.description}`);
  }

  const { status } = resolveConnections(profile);
  console.log('\n  CONNECTIONS\n');
  for (const s of status) {
    const mark = s.ready ? 'ok  ' : s.enabled ? 'FAIL' : '--  ';
    console.log(`  ${mark}  ${s.name.padEnd(10)} profile ${s.toolProfile.padEnd(10)} ${s.reason}`);
  }

  if (!status.some((s) => s.ready)) {
    console.log('\n  Nothing to connect to. Set the missing environment variables in .env\n');
    return;
  }

  console.log('\n  LIVE TOOL LIST (what the agent would load)\n');
  const tools = await mcpTools(profile);
  const names = Object.keys(tools);
  console.log(`  ${names.length} tools`);
  for (const n of names) console.log(`    ${n}`);
  console.log();
  await closeMcp();
}

main().catch(async (e) => {
  await closeMcp();
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
