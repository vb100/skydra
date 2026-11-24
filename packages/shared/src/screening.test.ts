import { describe, expect, it } from 'vitest';
import { screeningStatus } from './screening';

type M = Parameters<typeof screeningStatus>[0][number]['matches'][number];
const match = (over: Partial<M> = {}): M => ({
  strength: 'STRONG',
  reviewStatus: 'OPEN',
  categories: ['PEP'],
  ...over,
});
const done = (...matches: M[]) => ({ status: 'COMPLETED' as const, matches });
const failed = { status: 'FAILED' as const, matches: [] };

describe('screeningStatus', () => {
  it('is NOT_SCREENED or FAILED until a check completes', () => {
    expect(screeningStatus([])).toEqual({ status: 'NOT_SCREENED', lastAttemptFailed: false });
    expect(screeningStatus([failed])).toEqual({ status: 'FAILED', lastAttemptFailed: true });
  });

  it('is GREEN without strong matches, or when they are ruled out; weak ones do not count', () => {
    expect(screeningStatus([done()]).status).toBe('GREEN');
    expect(
      screeningStatus([done(match({ strength: 'WEAK', categories: ['SANCTIONS'] }))]).status,
    ).toBe('GREEN');
    expect(
      screeningStatus([done(match({ reviewStatus: 'FALSE_POSITIVE', categories: ['SANCTIONS'] }))])
        .status,
    ).toBe('GREEN');
    // An article about the person that is no risk.
    expect(
      screeningStatus([
        done(match({ reviewStatus: 'NOT_RELEVANT', categories: ['ADVERSE_MEDIA'] })),
      ]).status,
    ).toBe('GREEN');
  });

  it('is YELLOW while a strong match awaits review, or for confirmed adverse media / other lists', () => {
    expect(screeningStatus([done(match())]).status).toBe('YELLOW');
    expect(
      screeningStatus([done(match({ reviewStatus: 'TRUE_POSITIVE', categories: ['OTHER_LIST'] }))])
        .status,
    ).toBe('YELLOW');
  });

  it('is ORANGE for a confirmed PEP and RED for confirmed sanctions, whatever else', () => {
    expect(
      screeningStatus([
        done(match({ reviewStatus: 'TRUE_POSITIVE', categories: ['PEP_ASSOCIATE'] }), match()),
      ]).status,
    ).toBe('ORANGE');
    expect(
      screeningStatus([
        done(
          match({ reviewStatus: 'TRUE_POSITIVE', categories: ['PEP'] }),
          match({ reviewStatus: 'TRUE_POSITIVE', categories: ['SANCTIONS'] }),
        ),
      ]).status,
    ).toBe('RED');
  });

  it('keeps the latest completed result when a re-check fails, and says so', () => {
    const red = done(match({ reviewStatus: 'TRUE_POSITIVE', categories: ['SANCTIONS'] }));
    expect(screeningStatus([failed, red])).toEqual({ status: 'RED', lastAttemptFailed: true });
    expect(screeningStatus([done(), red]).status).toBe('GREEN');
  });
});
