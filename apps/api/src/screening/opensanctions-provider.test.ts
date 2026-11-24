import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { categoriesOf, OpenSanctionsProvider, queryFor } from './opensanctions-provider';
import { ProviderError, type ScreeningSubject } from './provider';

const person: ScreeningSubject = {
  partyType: 'NATURAL',
  name: 'Jonas Jonaitis',
  birthDate: '1980-05-12',
  countries: ['LT'],
};
const company: ScreeningSubject = {
  partyType: 'LEGAL',
  name: 'UAB „Pavyzdys“',
  birthDate: null,
  countries: ['LT'],
  registrationNumber: '123456789',
};

const result = (over: object = {}) => ({
  id: 'NK-abc',
  caption: 'Jonas Jonaitis',
  schema: 'Person',
  properties: {
    topics: ['role.pep'],
    position: ['Seimo narys'],
    birthDate: ['1980-05-12'],
    nationality: ['lt'],
  },
  datasets: ['lt_pep_declarations'],
  score: 0.91234,
  match: true,
  ...over,
});
const answer = (results: object[]) =>
  JSON.stringify({
    responses: { q: { status: 200, results, total: { value: results.length } } },
    limit: 10,
  });

/** A fetch that answers from a list of [status, body] and records each call. */
function fakeFetch(replies: ([number, string] | 'timeout' | 'network')[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply === 'timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(reply[1], { status: reply[0] });
  };
  return { calls, impl: impl as typeof fetch };
}

const provider = (f: typeof fetch, sleeps: number[] = []) =>
  new OpenSanctionsProvider({
    apiKey: 'secret-key',
    baseUrl: 'https://api.example.test',
    threshold: 0.7,
    fetch: f,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

describe('OpenSanctions provider', () => {
  it('sends only name, birth date and nationality for a person; company code for a company', () => {
    expect(queryFor(person)).toEqual({
      queries: {
        q: {
          schema: 'Person',
          properties: { name: ['Jonas Jonaitis'], birthDate: ['1980-05-12'], nationality: ['lt'] },
        },
      },
    });
    expect(queryFor(company).queries.q).toEqual({
      schema: 'Company',
      properties: {
        name: ['UAB „Pavyzdys“'],
        registrationNumber: ['123456789'],
        jurisdiction: ['lt'],
      },
    });
    expect(queryFor({ ...person, birthDate: null, countries: [] }).queries.q.properties).toEqual({
      name: ['Jonas Jonaitis'],
    });
  });

  it('calls /match with the key in the header only, and maps results', async () => {
    const f = fakeFetch([
      [
        200,
        answer([
          result(),
          result({
            id: 'NK-weak',
            score: 0.55,
            match: false,
            properties: { topics: ['sanction'] },
          }),
        ]),
      ],
    ]);
    const r = await provider(f.impl).screen(person);

    const [call] = f.calls;
    expect(call!.url).toBe(
      'https://api.example.test/match/default?algorithm=best&threshold=0.7&limit=10',
    );
    expect(call!.init.method).toBe('POST');
    expect((call!.init.headers as Record<string, string>).Authorization).toBe('ApiKey secret-key');
    expect(JSON.stringify(r.exchanges)).not.toContain('secret-key');

    expect(r.matches).toEqual([
      {
        externalId: 'NK-abc',
        name: 'Jonas Jonaitis',
        score: 91.23,
        strength: 'STRONG',
        categories: ['PEP'],
        details: {
          topics: 'role.pep',
          position: 'Seimo narys',
          birthDate: '1980-05-12',
          nationality: 'LT',
          datasets: 'lt_pep_declarations',
          entityUrl: 'https://www.opensanctions.org/entities/NK-abc/',
        },
      },
      expect.objectContaining({
        externalId: 'NK-weak',
        strength: 'WEAK',
        categories: ['SANCTIONS'],
        score: 55,
      }),
    ]);
  });

  it('keeps the exchange with a SHA-256 of the response exactly as received', async () => {
    const body = answer([]);
    const r = await provider(fakeFetch([[200, body]]).impl).screen(person);
    expect(r.matches).toEqual([]);
    expect(r.exchanges).toEqual([
      expect.objectContaining({
        attempt: 1,
        httpStatus: 200,
        error: null,
        request: {
          url: '/match/default?algorithm=best&threshold=0.7&limit=10',
          body: queryFor(person),
        },
        responseSha256: createHash('sha256').update(body).digest('hex'),
      }),
    ]);
  });

  it('retries a server error, rate limit or timeout up to three times with growing waits', async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([[503, '{"detail":"busy"}'], 'timeout', [200, answer([])]]);
    const r = await provider(f.impl, sleeps).screen(person);
    expect(f.calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(r.exchanges!.map((x) => [x.attempt, x.httpStatus, x.error])).toEqual([
      [1, 503, 'HTTP 503'],
      [2, null, 'timeout'],
      [3, 200, null],
    ]);

    const limited = fakeFetch([[429, '{}']]);
    const err = await provider(limited.impl)
      .screen(person)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).exchanges).toHaveLength(3);
  });

  it('does not retry a refused key or an invalid query, and says why', async () => {
    for (const status of [401, 422]) {
      const f = fakeFetch([[status, '{"detail":"no"}']]);
      const err = await provider(f.impl)
        .screen(person)
        .catch((e: unknown) => e);
      expect(f.calls).toHaveLength(1);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).message).toBe(`OpenSanctions: HTTP ${status}`);
      expect((err as ProviderError).exchanges[0]).toMatchObject({
        httpStatus: status,
        response: { detail: 'no' },
      });
    }
  });

  it('treats a network failure or an unexpected body as a failure, never as "no matches"', async () => {
    const down = await provider(fakeFetch(['network']).impl)
      .screen(person)
      .catch((e: unknown) => e);
    expect(down).toBeInstanceOf(ProviderError);
    expect((down as ProviderError).exchanges.map((x) => x.error)).toEqual([
      'network error',
      'network error',
      'network error',
    ]);

    const odd = await provider(fakeFetch([[200, '{"something":"else"}']]).impl)
      .screen(person)
      .catch((e: unknown) => e);
    expect(odd).toBeInstanceOf(ProviderError);
    expect((odd as ProviderError).message).toBe('OpenSanctions: unexpected response');

    const notJson = await provider(fakeFetch([[200, '<html>']]).impl)
      .screen(person)
      .catch((e: unknown) => e);
    expect((notJson as ProviderError).exchanges[0]).toMatchObject({
      error: 'invalid JSON',
      response: { unparsed: '<html>' },
    });
  });

  it('maps topics to categories; counter-sanctions are not a risk', () => {
    expect(categoriesOf(['sanction'])).toEqual(['SANCTIONS']);
    expect(categoriesOf(['sanction.control', 'sanction.linked'])).toEqual([
      'SANCTIONS',
      'OTHER_LIST',
    ]);
    expect(categoriesOf(['role.pep', 'role.rca'])).toEqual(['PEP', 'PEP_ASSOCIATE']);
    expect(categoriesOf(['crime.fin', 'debarment', 'reg.warn'])).toEqual(['OTHER_LIST']);
    expect(categoriesOf(['sanction.counter'])).toEqual(['OTHER_LIST']);
    expect(categoriesOf([])).toEqual(['OTHER_LIST']);
  });
});
