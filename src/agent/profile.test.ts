/**
 * These rows are copied from live actor output on 2026-09-04, not invented.
 * The bug this file guards against was a field the second source simply does
 * not have, and no amount of plausible-looking test data would have caught it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseProfile, renderProfiles, profileLabel, isResolvableProfileUrl,
  evidenceWarning, type RawProfile,
} from './profile.js';

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

describe('a URL somebody can actually open', () => {
  // Short mode puts a member id where the slug belongs. The resulting URL does
  // not resolve, and the model cannot tell from inside its loop.
  test('an opaque member id is not a usable profile link', () => {
    assert.equal(
      isResolvableProfileUrl('https://www.linkedin.com/in/ACwAAAHBqUgBCuiQE60bvIG0rkuBqPU9s4Ekxyw'),
      false,
    );
  });

  test('a vanity slug is', () => {
    assert.ok(isResolvableProfileUrl('https://www.linkedin.com/in/rachitchaudhary'));
    assert.ok(isResolvableProfileUrl('https://www.linkedin.com/in/sonia-van-der-linden-pugal'));
  });

  // Guard against the check being so eager it rejects real people: plenty of
  // slugs legitimately begin with "ac".
  test('a real name starting with those letters is not mistaken for an id', () => {
    assert.ok(isResolvableProfileUrl('https://www.linkedin.com/in/acacia-turner'));
    assert.ok(isResolvableProfileUrl('https://www.linkedin.com/in/achmed'));
  });

  test('an empty or non-profile URL is not usable', () => {
    assert.equal(isResolvableProfileUrl(''), false);
    assert.equal(isResolvableProfileUrl('https://www.linkedin.com/company/adyen/'), false);
  });

  test('publicIdentifier is used when the source gives no URL', () => {
    const p = normaliseProfile({ firstName: 'A', lastName: 'B', publicIdentifier: 'ab-person' });
    assert.equal(p.url, 'https://www.linkedin.com/in/ab-person');
    assert.ok(isResolvableProfileUrl(p.url));
  });
});

describe('telling the model the evidence was thin', () => {
  const SHORT_MODE_ROW: RawProfile = {
    firstName: 'Joshua', lastName: 'Wood',
    linkedinUrl: 'https://www.linkedin.com/in/ACwAAAHBqUgBCuiQE60bvIG0rkuBqPU9s4Ekxyw',
  };
  const FULL_MODE_ROW: RawProfile = {
    firstName: 'Rachit', lastName: 'Chaudhary',
    headline: 'Head of Product Marketing | Travel | eCommerce | Fintech',
    linkedinUrl: 'https://www.linkedin.com/in/rachitchaudhary',
    hiring: true,
  };

  test('a row with no title and a dead link is marked unusable, not dropped', () => {
    const p = normaliseProfile(SHORT_MODE_ROW);
    assert.equal(p.usable, false);
    assert.match(p.unusableReason, /no job title/);
    assert.match(p.unusableReason, /does not resolve/);
  });

  test('a complete row is usable', () => {
    assert.equal(normaliseProfile(FULL_MODE_ROW).usable, true);
  });

  // The model CAN judge "I cannot pick between these" — it just had no way to
  // know that was unusual. So it is told, with numbers, and left to decide.
  test('the warning counts the problem rather than asserting one', () => {
    const w = evidenceWarning([SHORT_MODE_ROW, SHORT_MODE_ROW, FULL_MODE_ROW]);
    assert.match(w, /2 of 3 came back with no job title/);
    assert.match(w, /2 of 3 have a profile URL that will not open/);
    assert.match(w, /this source returning reduced data/);
  });

  test('complete evidence produces no warning at all', () => {
    assert.equal(evidenceWarning([FULL_MODE_ROW, FULL_MODE_ROW]), '');
  });

  test('the hiring badge is surfaced, since it is the signal being inferred', () => {
    assert.match(renderProfiles([FULL_MODE_ROW]), /#hiring badge/);
    assert.ok(!renderProfiles([{ ...FULL_MODE_ROW, hiring: false }]).includes('#hiring'));
  });

  test('an unusable row is flagged in what the agent reads', () => {
    assert.match(renderProfiles([SHORT_MODE_ROW]), /\[incomplete:.*cannot be committed/);
  });
});
