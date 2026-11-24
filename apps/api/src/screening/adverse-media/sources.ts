import { z } from 'zod';
import { callWithRetry, type HttpOptions } from '../http-exchange';
import { ProviderError, type ProviderExchange, type ScreeningSubject } from '../provider';
import { domainOf, stripHtml, type Article } from './articles';
import { fittedQuery, mentions, nameVariants, relevanceStems, RISK_WORDS } from './queries';
import { Throttle } from './throttle';

/** What one source found for one subject, with every HTTP attempt as evidence. */
export type SourceOutcome = { articles: Article[]; exchanges: ProviderExchange[] };

/** A news or web search. A failure throws ProviderError carrying the attempts made so far. */
export interface MediaSource {
  readonly code: 'BRAVE' | 'GDELT';
  search(subject: ScreeningSubject): Promise<SourceOutcome>;
}

/** A date-time without a zone (Brave's page_age) is read as UTC, not as the server's local time. */
const isoDate = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const d = new Date(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}Z` : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ---------------------------------------------------------------------------------------------
// Brave Search API (https://api-dashboard.search.brave.com/app/documentation)

/** Parsed field by field: an unusable result is skipped, the rest are kept. */
const BraveResult = z.object({
  title: z.string().min(1),
  url: z.url(),
  description: z.string().nullish(),
  page_age: z.string().nullish(),
  meta_url: z.object({ hostname: z.string().nullish() }).nullish(),
});

export type BraveOptions = HttpOptions & {
  apiKey: string;
  baseUrl: string;
  throttle?: Throttle;
};

type BraveSearch = { kind: 'news' | 'web'; query: string; params: Record<string, string> };

/**
 * Three searches per subject: Lithuanian news, the Lithuanian web, and the web in English.
 * Brave may return pages that only loosely match the query, so a result is kept only when its
 * title or snippet names the subject.
 */
export class BraveSource implements MediaSource {
  readonly code = 'BRAVE' as const;
  private readonly throttle: Throttle;

  constructor(private readonly options: BraveOptions) {
    this.throttle = options.throttle ?? new Throttle(1_000);
  }

  searches(subject: ScreeningSubject): BraveSearch[] {
    const names = nameVariants(subject);
    const limits = { maxChars: 400, maxWords: 50 };
    const lt = fittedQuery(names.lt, RISK_WORDS.lt, limits);
    const en = fittedQuery(names.en, RISK_WORDS.en, limits);
    const local = { country: 'LT', search_lang: 'lt', spellcheck: '0' };
    return [
      { kind: 'news', query: lt, params: { ...local, count: '50' } },
      { kind: 'web', query: lt, params: { ...local, count: '20' } },
      { kind: 'web', query: en, params: { spellcheck: '0', count: '20' } },
    ];
  }

  async search(subject: ScreeningSubject): Promise<SourceOutcome> {
    const stems = relevanceStems(subject);
    const exchanges: ProviderExchange[] = [];
    const articles: Article[] = [];
    for (const s of this.searches(subject)) {
      await this.throttle.wait();
      const path = `/${s.kind}/search?${new URLSearchParams({ q: s.query, ...s.params })}`;
      const outcome = await callWithRetry(
        {
          provider: 'BRAVE',
          url: `${this.options.baseUrl}${path}`,
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Subscription-Token': this.options.apiKey },
          logged: { url: path },
        },
        this.options,
      );
      exchanges.push(...outcome.exchanges);
      if (!outcome.ok) throw new ProviderError(`Brave: ${outcome.error}`, exchanges);

      const json = outcome.json as { results?: unknown; web?: { results?: unknown } } | null;
      const list = s.kind === 'news' ? json?.results : (json?.web?.results ?? []);
      if (
        json === null ||
        typeof json !== 'object' ||
        (list !== undefined && !Array.isArray(list))
      ) {
        exchanges.at(-1)!.error = 'unexpected response';
        throw new ProviderError('Brave: unexpected response', exchanges);
      }
      for (const item of (list as unknown[] | undefined) ?? []) {
        const r = BraveResult.safeParse(item);
        if (!r.success) continue;
        const title = stripHtml(r.data.title);
        const snippet = r.data.description ? stripHtml(r.data.description) : null;
        if (!mentions(`${title} ${snippet ?? ''}`, stems)) continue;
        articles.push({
          url: r.data.url,
          title,
          snippet,
          domain: (r.data.meta_url?.hostname ?? domainOf(r.data.url)).replace(/^www\./, ''),
          publishedAt: isoDate(r.data.page_age),
          source: 'BRAVE',
        });
      }
    }
    return { articles, exchanges };
  }
}

// ---------------------------------------------------------------------------------------------
// GDELT DOC 2.0 API (https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)

const GdeltArticle = z.object({
  url: z.url(),
  title: z.string().min(1),
  seendate: z.string().nullish(),
  domain: z.string().nullish(),
});

/** 20240501T120000Z → 2024-05-01T12:00:00.000Z */
export function gdeltDate(value: string | null | undefined): string | null {
  const m = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? isoDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null;
}

export type GdeltOptions = HttpOptions & { baseUrl: string; throttle?: Throttle };

/**
 * One full-text search of world news over the last three months (the API's window), in all
 * languages, with the Lithuanian name forms and the risk words in both languages. Free, without
 * a key, but limited to one request every 5 seconds.
 */
export class GdeltSource implements MediaSource {
  readonly code = 'GDELT' as const;
  private readonly throttle: Throttle;

  constructor(private readonly options: GdeltOptions) {
    this.throttle = options.throttle ?? new Throttle(5_000);
  }

  query(subject: ScreeningSubject): string {
    const names = nameVariants(subject);
    return fittedQuery(
      [...new Set([...names.lt, ...names.en])],
      [...RISK_WORDS.lt, ...RISK_WORDS.en],
      { maxChars: 1000, maxWords: 150 },
    );
  }

  async search(subject: ScreeningSubject): Promise<SourceOutcome> {
    await this.throttle.wait();
    const params = new URLSearchParams({
      query: this.query(subject),
      mode: 'artlist',
      format: 'json',
      maxrecords: '50',
      timespan: '3months',
      sort: 'datedesc',
    });
    const path = `/api/v2/doc/doc?${params}`;
    const outcome = await callWithRetry(
      {
        provider: 'GDELT',
        url: `${this.options.baseUrl}${path}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        logged: { url: path },
      },
      this.options,
    );
    const { exchanges } = outcome;
    if (!outcome.ok) throw new ProviderError(`GDELT: ${outcome.error}`, exchanges);

    // No results is an empty object; errors come back as plain text (rejected above).
    const json = outcome.json as { articles?: unknown } | null;
    if (
      json === null ||
      typeof json !== 'object' ||
      (json.articles !== undefined && !Array.isArray(json.articles))
    ) {
      exchanges.at(-1)!.error = 'unexpected response';
      throw new ProviderError('GDELT: unexpected response', exchanges);
    }
    const articles: Article[] = [];
    for (const item of (json.articles as unknown[] | undefined) ?? []) {
      const r = GdeltArticle.safeParse(item);
      if (!r.success) continue;
      articles.push({
        url: r.data.url,
        title: stripHtml(r.data.title),
        snippet: null,
        domain: (r.data.domain ?? domainOf(r.data.url)).replace(/^www\./, ''),
        publishedAt: gdeltDate(r.data.seendate),
        source: 'GDELT',
      });
    }
    return { articles, exchanges };
  }
}
