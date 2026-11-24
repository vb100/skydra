import { describe, expect, it } from 'vitest';
import { RuleError } from '../../domain-errors';
import {
  ProviderError,
  type ProviderResult,
  type ScreeningProvider,
  type ScreeningSubject,
} from '../provider';
import { articleMatch, combine, MAX_ARTICLES, stripHtml, urlKey, type Article } from './articles';
import { WithAdverseMedia } from './provider';
import {
  companyName,
  fittedQuery,
  genitive,
  highlightTerms,
  mentions,
  nameVariants,
  relevanceStems,
  RISK_WORDS,
  searchQuery,
} from './queries';
import { BraveSource, gdeltDate, GdeltSource, type MediaSource } from './sources';
import { Throttle } from './throttle';

const person = (name: string): ScreeningSubject => ({
  partyType: 'NATURAL',
  name,
  birthDate: '1980-05-12',
  countries: ['LT'],
});
const company: ScreeningSubject = {
  partyType: 'LEGAL',
  name: 'UAB „Pavyzdys“',
  birthDate: null,
  countries: ['LT'],
  registrationNumber: '123456789',
};

/** A fetch answering from a list of [status, body] in turn, recording each URL and header. */
function fakeFetch(replies: ([number, string] | 'network')[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string> });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(reply[1], { status: reply[0] });
  };
  return { calls, impl: impl as typeof fetch };
}
const noWait = { sleep: () => Promise.resolve() };
const freeThrottle = () =>
  new Throttle(
    0,
    () => 0,
    () => Promise.resolve(),
  );

describe('name forms and queries', () => {
  it('declines Lithuanian names into the genitive', () => {
    expect(
      ['Jonas', 'Jonaitis', 'Jurgis', 'Darius', 'Petrauskienė', 'Ona', 'Mažeikys', 'Kęstutys'].map(
        genitive,
      ),
    ).toEqual([
      'Jono',
      'Jonaičio',
      'Jurgio',
      'Dariaus',
      'Petrauskienės',
      'Onos',
      'Mažeikio',
      'Kęstučio',
    ]);
    expect(genitive('Smith')).toBeNull();
  });

  it('searches a person as written, in the genitive and without Lithuanian letters', () => {
    expect(nameVariants(person('Jonas Jonaitis'))).toEqual({
      lt: ['Jonas Jonaitis', 'Jono Jonaičio', 'Jono Jonaicio'],
      en: ['Jonas Jonaitis'],
    });
    // A foreign name is not declined.
    expect(nameVariants(person('John Smith')).lt).toEqual(['John Smith']);
  });

  it('searches a company without its legal form and quotation marks', () => {
    expect(companyName('UAB „Pavyzdys“')).toBe('Pavyzdys');
    expect(companyName('Žalias miškas, MB')).toBe('Žalias miškas,');
    expect(nameVariants(company)).toEqual({ lt: ['Pavyzdys'], en: ['Pavyzdys'] });
  });

  it('builds the query from the names and the risk words', () => {
    expect(
      searchQuery(['Jonas Jonaitis', 'Jono Jonaičio'], ['sukčiavimas', 'pinigų plovimas']),
    ).toBe('("Jonas Jonaitis" OR "Jono Jonaičio") (sukčiavimas OR "pinigų plovimas")');
    expect(searchQuery(['Pavyzdys'], ['fraud'])).toBe('"Pavyzdys" fraud');
  });

  it('keeps a query within the limits by dropping risk words from the end', () => {
    const names = nameVariants(person('Konstantinas Aleksandravičius')).lt;
    const q = fittedQuery(names, RISK_WORDS.lt, { maxChars: 400, maxWords: 50 });
    expect(q.length).toBeLessThanOrEqual(400);
    expect(q.split(/\s+/).length).toBeLessThanOrEqual(50);
    for (const n of names) expect(q).toContain(`"${n}"`);
    expect(q).toContain('sukčiavimas');
  });

  it('recognises the subject in a text in any of its forms', () => {
    const stems = relevanceStems(person('Jonas Jonaitis'));
    expect(stems).toEqual(['jonai']);
    expect(mentions('Teismas nuteisė Jono Jonaičio bendrininką', stems)).toBe(true);
    expect(mentions('JONAICIO byla', stems)).toBe(true);
    expect(mentions('Petras Petraitis sulaikytas', stems)).toBe(false);
    expect(relevanceStems(company)).toEqual(['pavyzdys']);
  });

  it('highlights the names and the stems of the risk words', () => {
    const terms = highlightTerms(['Jonas Jonaitis']);
    expect(terms).toContain('Jonas Jonaitis');
    expect(terms).toContain('sukčiavim');
    expect(terms).toContain('pinigų plovim');
    expect(terms).toContain('STT');
  });
});

describe('articles', () => {
  const article = (over: Partial<Article> = {}): Article => ({
    url: 'https://www.lrt.lt/naujienos/1?utm_source=x',
    title: 'Jonas Jonaitis sulaikytas',
    snippet: 'Trumpas',
    domain: 'lrt.lt',
    publishedAt: '2026-10-01T00:00:00.000Z',
    source: 'BRAVE',
    ...over,
  });

  it('gives the same article one key', () => {
    expect(urlKey('https://www.lrt.lt/naujienos/1/?utm_source=x#top')).toBe('lrt.lt/naujienos/1');
    expect(urlKey('http://lrt.lt/naujienos/1')).toBe('lrt.lt/naujienos/1');
    expect(urlKey('https://lrt.lt/a?id=5&utm_medium=y')).toBe('lrt.lt/a?id=5');
  });

  it('merges duplicates from both sources, newest first, at most 25', () => {
    const merged = combine([
      article(),
      article({
        url: 'http://lrt.lt/naujienos/1',
        snippet: 'Ilgesnis fragmentas',
        source: 'GDELT',
      }),
      article({ url: 'https://15min.lt/x', publishedAt: '2026-11-01T00:00:00.000Z' }),
      article({ url: 'https://delfi.lt/y', publishedAt: null }),
    ]);
    expect(merged.map((a) => a.domain && urlKey(a.url))).toEqual([
      '15min.lt/x',
      'lrt.lt/naujienos/1',
      'delfi.lt/y',
    ]);
    expect(merged[1]).toMatchObject({
      sources: ['BRAVE', 'GDELT'],
      snippet: 'Ilgesnis fragmentas',
    });

    const many = Array.from({ length: 40 }, (_, i) => article({ url: `https://lrt.lt/${i}` }));
    expect(combine(many)).toHaveLength(MAX_ARTICLES);
  });

  it('becomes a strong ADVERSE_MEDIA match with the article as details', () => {
    const [a] = combine([article()]);
    expect(articleMatch(a!, ['Jonas Jonaitis'])).toEqual({
      externalId: 'lrt.lt/naujienos/1',
      name: 'Jonas Jonaitis sulaikytas',
      score: null,
      strength: 'STRONG',
      categories: ['ADVERSE_MEDIA'],
      details: {
        kind: 'article',
        title: 'Jonas Jonaitis sulaikytas',
        sourceUrl: 'https://www.lrt.lt/naujienos/1?utm_source=x',
        domain: 'lrt.lt',
        publishedAt: '2026-10-01T00:00:00.000Z',
        snippet: 'Trumpas',
        source: 'Brave',
        terms: ['Jonas Jonaitis'],
      },
    });
  });

  it('strips HTML from titles and snippets', () => {
    expect(stripHtml('<strong>Jonas</strong> &amp; Co &quot;x&quot;')).toBe('Jonas & Co "x"');
  });
});

describe('throttle', () => {
  it('spaces calls by the interval', async () => {
    let now = 0;
    const waits: number[] = [];
    const t = new Throttle(
      5_000,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await Promise.all([t.wait(), t.wait(), t.wait()]);
    expect(waits).toEqual([5_000, 5_000]);
  });
});

const braveNews = (results: object[]) => JSON.stringify({ type: 'news', results });
const braveWeb = (results: object[]) => JSON.stringify({ type: 'search', web: { results } });
const braveResult = (over: object = {}) => ({
  title: '<strong>Jono Jonaičio</strong> byla',
  url: 'https://www.lrt.lt/naujienos/1',
  description: 'Teismas nagrinėja <strong>sukčiavimo</strong> bylą',
  page_age: '2026-10-01T10:00:00',
  meta_url: { hostname: 'www.lrt.lt' },
  ...over,
});

describe('Brave source', () => {
  const brave = (f: typeof fetch) =>
    new BraveSource({
      apiKey: 'brave-secret',
      baseUrl: 'https://brave.example.test/res/v1',
      fetch: f,
      throttle: freeThrottle(),
      ...noWait,
    });

  it('searches Lithuanian news, the Lithuanian web and the web in English', async () => {
    const f = fakeFetch([
      [200, braveNews([braveResult()])],
      [
        200,
        braveWeb([
          braveResult({ url: 'https://15min.lt/a', title: 'Kita', description: 'Apie kitą žmogų' }),
        ]),
      ],
      [200, JSON.stringify({ type: 'search' })],
    ]);
    const { articles, exchanges } = await brave(f.impl).search(person('Jonas Jonaitis'));

    const urls = f.calls.map((c) => new URL(c.url));
    expect(urls.map((u) => u.pathname)).toEqual([
      '/res/v1/news/search',
      '/res/v1/web/search',
      '/res/v1/web/search',
    ]);
    expect(urls[0]!.searchParams.get('country')).toBe('LT');
    expect(urls[0]!.searchParams.get('q')).toContain('"Jono Jonaičio"');
    expect(urls[2]!.searchParams.get('q')).toContain('fraud');
    expect(urls[2]!.searchParams.has('country')).toBe(false);
    expect(f.calls[0]!.headers['X-Subscription-Token']).toBe('brave-secret');

    // The key never reaches the evidence; each call is one exchange.
    expect(JSON.stringify(exchanges)).not.toContain('brave-secret');
    expect(exchanges.map((x) => x.provider)).toEqual(['BRAVE', 'BRAVE', 'BRAVE']);

    // A result that does not name the subject is left out.
    expect(articles).toEqual([
      {
        url: 'https://www.lrt.lt/naujienos/1',
        title: 'Jono Jonaičio byla',
        snippet: 'Teismas nagrinėja sukčiavimo bylą',
        domain: 'lrt.lt',
        publishedAt: '2026-10-01T10:00:00.000Z',
        source: 'BRAVE',
      },
    ]);
  });

  it('skips unusable results and fails on an unexpected answer', async () => {
    const ok = fakeFetch([
      [200, braveNews([{ title: 'x' }, braveResult()])],
      [200, braveWeb([])],
    ]);
    expect((await brave(ok.impl).search(person('Jonas Jonaitis'))).articles).toHaveLength(1);

    const odd = fakeFetch([[200, JSON.stringify({ results: 'nope' })]]);
    await expect(brave(odd.impl).search(person('Jonas Jonaitis'))).rejects.toThrow(
      /unexpected response/,
    );
  });

  it('fails with the attempts made when Brave refuses', async () => {
    const f = fakeFetch([[401, '{"error":"invalid token"}']]);
    const error = await brave(f.impl)
      .search(person('Jonas Jonaitis'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe('Brave: HTTP 401');
    expect((error as ProviderError).exchanges).toHaveLength(1);
  });
});

describe('GDELT source', () => {
  const gdelt = (f: typeof fetch) =>
    new GdeltSource({
      baseUrl: 'https://gdelt.example.test',
      fetch: f,
      throttle: freeThrottle(),
      ...noWait,
    });

  it('searches the last three months of news once per subject', async () => {
    const f = fakeFetch([
      [
        200,
        JSON.stringify({
          articles: [
            {
              url: 'https://www.delfi.lt/a',
              title: 'Įtarimai verslininkui',
              seendate: '20261020T081500Z',
              domain: 'delfi.lt',
              language: 'Lithuanian',
            },
            { title: 'no url' },
          ],
        }),
      ],
    ]);
    const { articles, exchanges } = await gdelt(f.impl).search(person('Jonas Jonaitis'));
    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe('/api/v2/doc/doc');
    expect(url.searchParams.get('timespan')).toBe('3months');
    expect(url.searchParams.get('query')).toMatch(/^\("Jonas Jonaitis" OR "Jono Jonaičio"/);
    expect(exchanges[0]!.provider).toBe('GDELT');
    expect(articles).toEqual([
      {
        url: 'https://www.delfi.lt/a',
        title: 'Įtarimai verslininkui',
        snippet: null,
        domain: 'delfi.lt',
        publishedAt: '2026-10-20T08:15:00.000Z',
        source: 'GDELT',
      },
    ]);
  });

  it('treats an empty answer as nothing found and a text answer as a failure', async () => {
    const empty = fakeFetch([[200, '{}']]);
    expect((await gdelt(empty.impl).search(person('Jonas Jonaitis'))).articles).toEqual([]);

    const text = fakeFetch([[200, 'Your search contained a phrase that was too short.']]);
    await expect(gdelt(text.impl).search(person('Jonas Jonaitis'))).rejects.toThrow(/invalid JSON/);
  });

  it('reads GDELT dates', () => {
    expect(gdeltDate('20240501T120000Z')).toBe('2024-05-01T12:00:00.000Z');
    expect(gdeltDate('yesterday')).toBeNull();
  });
});

describe('lists and media in one check', () => {
  const listMatch = {
    externalId: 'NK-1',
    name: 'Jonas Jonaitis',
    score: 91,
    strength: 'STRONG' as const,
    categories: ['PEP' as const],
    details: {},
  };
  const exchange = (provider: string) => ({
    provider,
    attempt: 1,
    request: {},
    response: {},
    httpStatus: 200,
    responseSha256: 'a'.repeat(64),
    error: null,
    durationMs: 1,
    sentAt: new Date(),
  });
  const lists = (result: Promise<ProviderResult>): ScreeningProvider => ({
    mode: 'OPENSANCTIONS',
    sources: ['OPENSANCTIONS'],
    screen: () => result,
  });
  const media = (code: 'BRAVE' | 'GDELT', outcome: MediaSource['search']): MediaSource => ({
    code,
    search: outcome,
  });
  const found = (code: 'BRAVE' | 'GDELT', url: string) =>
    media(code, () =>
      Promise.resolve({
        articles: [
          {
            url,
            title: 'Jonas Jonaitis sulaikytas',
            snippet: null,
            domain: 'lrt.lt',
            publishedAt: null,
            source: code,
          },
        ],
        exchanges: [exchange(code)],
      }),
    );
  const ok = lists(
    Promise.resolve({
      reference: null,
      matches: [listMatch],
      exchanges: [exchange('OPENSANCTIONS')],
    }),
  );

  it('adds the articles of every source to the list matches', async () => {
    const provider = new WithAdverseMedia(ok, [
      found('BRAVE', 'https://lrt.lt/1'),
      found('GDELT', 'https://www.lrt.lt/1/'),
    ]);
    expect(provider.sources).toEqual(['OPENSANCTIONS', 'BRAVE', 'GDELT']);
    const result = await provider.screen(person('Jonas Jonaitis'));
    expect(result.matches.map((m) => m.categories[0])).toEqual(['PEP', 'ADVERSE_MEDIA']);
    expect(result.matches[1]!.details).toMatchObject({ source: 'Brave, GDELT' });
    expect(result.exchanges!.map((x) => x.provider)).toEqual(['OPENSANCTIONS', 'BRAVE', 'GDELT']);
  });

  it('fails the whole check when one source fails, keeping every attempt', async () => {
    const provider = new WithAdverseMedia(ok, [
      found('BRAVE', 'https://lrt.lt/1'),
      media('GDELT', () =>
        Promise.reject(new ProviderError('GDELT: timeout', [exchange('GDELT')])),
      ),
    ]);
    const error = await provider.screen(person('Jonas Jonaitis')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe('GDELT: timeout');
    expect((error as ProviderError).exchanges.map((x) => x.provider)).toEqual([
      'OPENSANCTIONS',
      'BRAVE',
      'GDELT',
    ]);
  });

  it('reports a configuration problem as such, not as an outage', async () => {
    const provider = new WithAdverseMedia(lists(Promise.reject(new RuleError('not available'))), [
      found('BRAVE', 'https://lrt.lt/1'),
    ]);
    await expect(provider.screen(person('Jonas Jonaitis'))).rejects.toBeInstanceOf(RuleError);
  });
});
