import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screen, passed } from './gates.js';
import type { JobPosting } from '../sources/types.js';
import type { ScreenConfig } from '../config-file.js';

const NOW = new Date('2026-09-04T12:00:00Z');

const config: ScreenConfig = {
  operatorCountry: 'Netherlands',
  homeLocalities: ['amsterdam', 'utrecht', 'rotterdam'],
  acceptRemoteIn: ['Netherlands', 'Europe', 'EMEA'],
  maxAgeDays: 14,
  minSalary: 70000,
  salaryCurrency: 'EUR',
  titleMustMatch: ['product manager', 'product lead', 'head of product'],
  titleMustNotMatch: ['intern', 'junior', 'marketing manager'],
  skills: ['marketplace', 'b2b saas', 'activation', 'gtm'],
  minSkillMatches: 1,
};

const base: JobPosting = {
  id: 'greenhouse:1', source: 'greenhouse', sourceId: '1',
  title: 'Senior Product Manager', company: 'Acme',
  location: 'Utrecht, Netherlands', remote: false,
  description: 'Own the marketplace funnel and improve activation.',
  url: 'https://example.com/job', postedAt: '2026-09-01T00:00:00Z',
  employmentType: 'Full-time', seniority: null, department: 'Product',
  salaryMin: null, salaryMax: null, companySize: 120,
  companyUrl: null, companyLinkedinUrl: null,
  contactName: null, contactTitle: null, contactProfileUrl: null,
  applicantCount: null,
};

const gate = (job: JobPosting, name: string) =>
  screen(job, NOW, config).find((g) => g.gate === name)!;

test('a clean, relevant, local posting passes every gate', () => {
  assert.equal(passed(screen(base, NOW, config)), true);
});

test('a title matching nothing wanted is rejected', () => {
  assert.equal(gate({ ...base, title: 'Data Engineer' }, 'title_wanted').passed, false);
});

test('an excluded title is rejected even when it also matches a wanted one', () => {
  const g = screen({ ...base, title: 'Junior Product Manager' }, NOW, config);
  assert.equal(g.find((x) => x.gate === 'title_wanted')!.passed, true);
  assert.equal(g.find((x) => x.gate === 'title_not_excluded')!.passed, false);
  assert.equal(passed(g), false);
});

test('a role in another country is rejected', () => {
  assert.equal(gate({ ...base, location: 'Berlin, Germany' }, 'location_eligible').passed, false);
});

test('a remote-in-Europe role is accepted from the Netherlands', () => {
  const g = gate({ ...base, location: 'Remote - Europe', remote: true }, 'location_eligible');
  assert.equal(g.passed, true);
});

test('a home-country city with no country named is recognised as local', () => {
  // Greenhouse writes "Utrecht" with no country. It has to be recognised by
  // name or every Dutch posting on that board is dropped.
  assert.equal(gate({ ...base, location: 'Utrecht' }, 'location_eligible').passed, true);
});

test('an unrecognised bare locality is rejected, not waved through', () => {
  // The first live run passed 3,084 Bjak postings across Asian markets because
  // a short bare locality was treated as "country unknown".
  const g = gate({ ...base, location: 'Kuala Lumpur' }, 'location_eligible');
  assert.equal(g.passed, false);
  assert.match(g.detail, /not in Netherlands/);
});

test('a missing posting date is unknown, not stale', () => {
  const g = gate({ ...base, postedAt: null }, 'fresh');
  assert.equal(g.passed, true);
  assert.match(g.detail, /no posting date/);
});

test('a posting past the freshness window is rejected', () => {
  assert.equal(gate({ ...base, postedAt: '2026-07-01T00:00:00Z' }, 'fresh').passed, false);
});

test('an absent salary passes, because most boards publish none', () => {
  assert.equal(gate(base, 'pay_acceptable').passed, true);
});

test('a published salary below the floor is a real rejection', () => {
  assert.equal(gate({ ...base, salaryMax: 55000 }, 'pay_acceptable').passed, false);
});

test('a published salary above the floor passes', () => {
  assert.equal(gate({ ...base, salaryMin: 80000, salaryMax: 95000 }, 'pay_acceptable').passed, true);
});

test('a posting matching no listed skill is rejected', () => {
  const g = gate({ ...base, description: 'Manage a roadmap for our internal tooling.' }, 'relevant');
  assert.equal(g.passed, false);
});

test('relevance reports which skills matched', () => {
  assert.match(gate(base, 'relevant').detail, /marketplace/);
});
