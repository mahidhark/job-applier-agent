/**
 * These rows are copied from live actor output on 2026-09-04, not invented.
 * The bug this file guards against was a field the second source simply does
 * not have, and no amount of plausible-looking test data would have caught it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProfile, renderProfiles, profileLabel, type RawProfile } from './profile.js';

/** harvestapi/linkedin-profile-search — has `headline`, no `summary`. */
const FROM_PROFILE_SEARCH: RawProfile = {
  firstName: 'Ingmar',
  lastName: 'van Dongen',
  headline: 'Brand Captain @ Homedeal | Skydreams',
  linkedinUrl: 'https://www.linkedin.com/in/ingmarvandongen',
  location: { linkedinText: 'Utrecht, Netherlands' },
};

/** harvestapi/linkedin-company-employees — NO `headline` field at all. */
const FROM_COMPANY_EMPLOYEES: RawProfile = {
  firstName: 'Joshua',
  lastName: 'Wood',
  summary: 'Proven leader of start-up/scale-up/global organizations.\nExtremely driven.',
  linkedinUrl: 'https://www.linkedin.com/in/ACwAAAHBqUgBCuiQE60bvIG0rkuBqPU9s4Ekxyw',
  location: { linkedinText: 'Amsterdam, North Holland, Netherlands' },
  currentPositions: [{
    title: 'Director Business Travel & Head of Booking.com for Business',
    companyName: 'Booking.com',
    current: true,
    tenureAtCompany: { numYears: 11, numMonths: 11 },
  }],
};

describe('a person from either source', () => {
  test('the source with a headline uses it', () => {
    assert.equal(normaliseProfile(FROM_PROFILE_SEARCH).title, 'Brand Captain @ Homedeal | Skydreams');
  });

  // The bug: this source has no `headline`, so reading only that field rendered
  // every person as "no headline" and threw the job title away — on the only
  // source that was working.
  test('the source with no headline still yields a title', () => {
    const p = normaliseProfile(FROM_COMPANY_EMPLOYEES);
    assert.match(p.title, /Director Business Travel/);
    assert.match(p.title, /Booking\.com/);
    assert.ok(!/no headline|no title/.test(p.title));
  });

  test('tenure is kept, because nine years somewhere is a different contact', () => {
    assert.equal(normaliseProfile(FROM_COMPANY_EMPLOYEES).tenure, '11 years at the company');
    assert.equal(normaliseProfile(FROM_PROFILE_SEARCH).tenure, '');
  });

  test('months are used when there are no whole years', () => {
    const p = normaliseProfile({
      ...FROM_COMPANY_EMPLOYEES,
      currentPositions: [{ title: 'PM', current: true, tenureAtCompany: { numYears: 0, numMonths: 4 } }],
    });
    assert.equal(p.tenure, '4 months at the company');
  });

  test('the About text is a last resort, and is truncated to one line', () => {
    const p = normaliseProfile({ firstName: 'A', lastName: 'B', summary: 'Line one.\nLine two.' });
    assert.equal(p.title, 'Line one.');
  });

  test('a row with nothing usable says so rather than pretending', () => {
    assert.equal(normaliseProfile({ firstName: 'A', lastName: 'B' }).title, 'no title given');
    assert.equal(normaliseProfile({}).name, '(no name)');
  });

  test('the current position wins over a past one', () => {
    const p = normaliseProfile({
      firstName: 'A', lastName: 'B',
      currentPositions: [
        { title: 'Intern', companyName: 'Old Co', current: false },
        { title: 'Head of Product', companyName: 'New Co', current: true },
      ],
    });
    assert.equal(p.title, 'Head of Product at New Co');
  });
});

describe('what the agent and the grading sheet actually read', () => {
  test('every rendered person carries a title', () => {
    const text = renderProfiles([FROM_PROFILE_SEARCH, FROM_COMPANY_EMPLOYEES]);
    assert.match(text, /Ingmar van Dongen — Brand Captain/);
    assert.match(text, /Joshua Wood — Director Business Travel/);
    assert.ok(!text.includes('no headline'));
  });

  test('the url survives, since it is what the scorer matches on', () => {
    const text = renderProfiles([FROM_COMPANY_EMPLOYEES]);
    assert.ok(text.includes('linkedin.com/in/ACwAAAHBqUgB'));
  });

  test('the grading sheet line is one line and names the role', () => {
    const line = profileLabel(FROM_COMPANY_EMPLOYEES);
    assert.ok(!line.includes('\n'));
    assert.match(line, /Joshua Wood/);
    assert.match(line, /Director Business Travel/);
    assert.match(line, /11 years/);
  });
});

test('a title that already names the employer does not repeat it', () => {
  const p = normaliseProfile({
    firstName: 'Joshua', lastName: 'Wood',
    currentPositions: [{ title: 'Head of Booking.com for Business', companyName: 'Booking.com', current: true }],
  });
  assert.equal(p.title, 'Head of Booking.com for Business');
});
