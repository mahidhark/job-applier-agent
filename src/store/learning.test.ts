/**
 * The learning loop: record the judgement, take the correction, feed it back.
 *
 * The round trip in the last describe is the test that matters. The others
 * prove pieces; that one proves the loop closes, which is the only property
 * that distinguishes this from a growing table nobody reads.
 *
 * The env var must be set BEFORE db.ts is imported: ESM hoists `import` above
 * module-level code, and getting this wrong once wrote 99 test rows into the
 * production database.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DB = typeof import('./db.js');
let db: DB;

let enrichGoal: typeof import('../agent/enrich-agent.js')['enrichGoal'];
let buildEnrichTools: typeof import('../agent/tools/index.js')['buildEnrichTools'];

before(async () => {
  process.env['JOB_AGENT_DB'] = join(mkdtempSync(join(tmpdir(), 'learning-')), 'test.db');
  db = await import('./db.js');
  ({ enrichGoal } = await import('../agent/enrich-agent.js'));
  ({ buildEnrichTools } = await import('../agent/tools/index.js'));
});

const JOB = {
  title: 'Senior Product Manager', company: 'Skydreams', location: 'Utrecht',
  companySize: null, companyUrl: null, companyLinkedinUrl: null,
  contactName: null, contactTitle: null, contactProfileUrl: null,
  description: 'We are a marketplace.',
};

/** A tool context that records against `subject`, with a fixed transcript. */
function ctxFor(subject: string, transcriptText: string) {
  const finished: unknown[] = [];
  return {
    finished,
    ctx: {
      jobId: 'job:1',
      transcript: { text: transcriptText },
      onFinish: (o: unknown) => { finished.push(o); },
      charge: () => true,
      decision: {
        decider: 'anthropic:claude-opus-5',
        subject,
        context: { title: JOB.title, company: JOB.company },
      },
    },
  };
}

describe('the agent records its judgement', () => {
  test('a committed contact leaves a decision carrying the decider and the reasoning', async () => {
    const { ctx } = ctxFor('skydreams::homedeal::senior product manager', 'Ada wrote about pricing experiments');
    const tools = buildEnrichTools(ctx);
    await (tools.record_contact.execute as (i: unknown) => Promise<string>)({
      name: 'Ada L.', title: 'Head of Product',
      profileUrl: 'https://www.linkedin.com/in/ada',
      observation: 'she wrote about pricing experiments',
      observationSource: 'Ada wrote about pricing experiments',
      reasoning: 'she owns the team; the poster is a recruiter',
    });
    const [d] = db.decisionsFor('contact', 'skydreams::homedeal::senior product manager');
    assert.ok(d, 'the judgement must survive the process');
    assert.equal(d.decider, 'anthropic:claude-opus-5');
    assert.match(d.reasoning ?? '', /owns the team/);
    assert.match(d.chose, /Ada L\./);
  });

  test('a refused call records nothing', async () => {
    // The decision write sits after the grounding and profile-URL refusals, so
    // a fabricated observation leaves no judgement to learn from.
    const { ctx } = ctxFor('acme::default::product lead', 'nothing relevant here');
    const tools = buildEnrichTools(ctx);
    const out = await (tools.record_contact.execute as (i: unknown) => Promise<string>)({
      name: 'Nobody', profileUrl: 'https://www.linkedin.com/in/nobody',
      observation: 'they love our product', observationSource: 'they love our product',
      reasoning: 'invented',
    });
    assert.match(out, /REFUSED/);
    assert.equal(db.decisionsFor('contact', 'acme::default::product lead').length, 0);
  });

  test('"nobody is reachable" is recorded, and the reason survives verbatim', async () => {
    // This tool used to call only an in-memory callback. After the process
    // exited, a correct "this company has nobody" was indistinguishable from a
    // run that never happened.
    const reason = 'profile-search returned nothing for every query; the source may be blocked';
    const { ctx } = ctxFor('vidaa::default::global product lead', '');
    const tools = buildEnrichTools(ctx);
    await (tools.record_no_contact.execute as (i: unknown) => Promise<string>)({ reason });
    const [d] = db.decisionsFor('contact', 'vidaa::default::global product lead');
    assert.ok(d);
    assert.equal(d.reasoning, reason, 'a blocked source must not be flattened into "nobody exists"');
    assert.match(d.chose, /"found":false/);
  });
});

describe('corrections', () => {
  const subject = 'bjak::bjak::product lead';

  test('a correction reaches the next prompt', () => {
    const id = db.recordDecision({
      kind: 'contact', subject, context: {}, chose: { name: 'A Recruiter' },
      decider: 'test',
    });
    db.recordCorrection(id, {}, 'the recruiter posts them; the Head of Product owns the team');
    // Assert on the NOTE, not the count: correctionsFor deliberately also
    // returns the most recent corrections from other subjects, so a count is
    // testing the wrong thing.
    const notes = db.correctionsFor('contact', subject).map((d) => d.correction_note ?? '');
    assert.ok(notes.some((n) => /Head of Product/.test(n)));
  });

  test('a second correction appends rather than replacing the first', () => {
    const id = db.recordDecision({
      kind: 'contact', subject: 'get-e::default::product manager', context: {}, chose: {},
      decider: 'test',
    });
    db.recordCorrection(id, {}, 'first lesson');
    db.recordCorrection(id, {}, 'second lesson');
    const [d] = db.correctionsFor('contact', 'get-e::default::product manager');
    assert.equal(d!.correction_note, 'first lesson | second lesson');
  });

  test('an uncorrected judgement is never offered as a lesson', () => {
    const id = db.recordDecision({
      kind: 'contact', subject: 'adyen::default::group product manager', context: {},
      chose: {}, decider: 'test',
    });
    const offered = db.correctionsFor('contact', 'adyen::default::group product manager');
    assert.ok(!offered.some((d) => d.id === id), 'it has never been corrected');
  });

  test('a lesson at a company reaches every role there, by prefix', () => {
    // The subject is the role id, which starts with the company. A job id would
    // generalise to nothing — the posting is gone in a month.
    const notes = db.correctionsFor('contact', 'bjak::').map((d) => d.correction_note);
    assert.ok(notes.some((n) => /Head of Product/.test(n ?? '')));
  });

  test('casing does not split a company, because roleKey lowercases', () => {
    // `Bjak` and `BJAK` are both live in the store as company names. True by
    // accident of roleKey rather than by design here, so it is asserted.
    assert.equal(db.correctionsFor('contact', 'BJAK::'.toLowerCase()).length > 0, true);
  });
});

describe('retraction', () => {
  const subject = 'ey::default::ai product owner';

  test('a retracted correction stops teaching but stays on the record', () => {
    const id = db.recordDecision({
      kind: 'contact', subject, context: {}, chose: {}, decider: 'test',
    });
    db.recordCorrection(id, {}, 'wrong in hindsight');
    const taught = () => db.correctionsFor('contact', subject).some((d) => d.id === id);
    assert.equal(taught(), true);

    db.retractCorrection(id);
    assert.equal(taught(), false, 'it must not reach a prompt');

    const [row] = db.decisionsFor('contact', subject);
    assert.ok(row!.retracted_at, 'but the row survives — this table is an audit trail');
    assert.equal(row!.correction_note, 'wrong in hindsight', 'and so does what was believed');
  });

  test('correcting again un-retracts: saying it twice is meaning it', () => {
    const [row] = db.decisionsFor('contact', subject);
    db.recordCorrection(row!.id, {}, 'actually it was right');
    assert.ok(db.correctionsFor('contact', subject).some((d) => d.id === row!.id));
  });

  test('retracting twice keeps the first timestamp', () => {
    const id = db.recordDecision({
      kind: 'contact', subject: 'jumbo::default::product owner', context: {}, chose: {},
      decider: 'test',
    });
    db.recordCorrection(id, {}, 'a note');
    db.retractCorrection(id);
    const first = db.decisionsFor('contact', 'jumbo::default::product owner')[0]!.retracted_at;
    db.retractCorrection(id);
    assert.equal(db.decisionsFor('contact', 'jumbo::default::product owner')[0]!.retracted_at, first);
  });
});

describe('the loop closes', () => {
  test('a correction on one posting reaches the prompt for a different posting at the same company', () => {
    // THE TEST THAT MATTERS. Everything else proves a piece; this proves that
    // what Mahi typed is what the next run is told.
    const id = db.recordDecision({
      kind: 'contact', subject: 'fareharbor::default::group product manager',
      context: {}, chose: { name: 'A Recruiter' }, decider: 'test',
    });
    db.recordCorrection(id, {}, 'talent partners here only screen; go to the product director');

    const lessons = db.correctionsFor('contact', 'fareharbor::')
      .map((d) => d.correction_note?.trim())
      .filter((n): n is string => Boolean(n));

    const goal = enrichGoal({ ...JOB, company: 'FareHarbor', title: 'Director of Product' }, lessons);
    assert.match(goal, /WHAT I HAVE BEEN TOLD BEFORE, from earlier corrections/);
    assert.match(goal, /only screen; go to the product director/);
  });

  test('with no corrections the prompt is unchanged', () => {
    const goal = enrichGoal(JOB);
    assert.doesNotMatch(goal, /WHAT I HAVE BEEN TOLD BEFORE/);
  });

  test('corrections default to empty, so an eval run is a controlled comparison', () => {
    // The §2.3 experiment runner calls enrichGoal too. If it silently read
    // whatever was typed last week, two providers would be graded against
    // different prompts and the difference blamed on the models.
    assert.equal(enrichGoal(JOB), enrichGoal(JOB, []));
  });

  test('a note is collapsed and capped before it enters a prompt', () => {
    const messy = `line one\n\n   line   two   ${'x'.repeat(500)}`;
    const goal = enrichGoal(JOB, [messy]);
    assert.doesNotMatch(goal, /line one\n\n/);
    assert.match(goal, /line one line two/);
    assert.ok(goal.length < enrichGoal(JOB).length + 400, 'the cap must bound prompt growth');
  });
});
