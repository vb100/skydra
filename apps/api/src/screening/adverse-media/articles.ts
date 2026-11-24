import type { ProviderMatch } from '../provider';

/** One news or web result, as both sources are reduced to before they are combined. */
export type Article = {
  url: string;
  title: string;
  snippet: string | null;
  domain: string;
  /** ISO date-time, when the source gives one. */
  publishedAt: string | null;
  source: 'BRAVE' | 'GDELT';
};

const SOURCE_LABELS = { BRAVE: 'Brave', GDELT: 'GDELT' } as const;

/** At most this many articles per check, newest first: more is noise for a broker to review. */
export const MAX_ARTICLES = 25;

/** Lower case, without diacritics: how names are compared in titles and snippets. */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Text without HTML tags and entities (Brave marks the query words with <strong>). */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e: string) =>
      e === 'amp'
        ? '&'
        : e === 'lt'
          ? '<'
          : e === 'gt'
            ? '>'
            : e === 'quot'
              ? '"'
              : e === 'nbsp'
                ? ' '
                : "'",
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref)$/i;

/**
 * The same article found twice (by both sources, or over http and https) has one key: no
 * protocol, no `www.`, no tracking parameters, no trailing slash, no fragment.
 */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) if (TRACKING.test(p)) u.searchParams.delete(p);
    const query = u.searchParams.toString();
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Merges duplicates (keeping the longer snippet and both sources), newest first, capped. */
export function combine(
  articles: readonly Article[],
): (Article & { sources: Article['source'][] })[] {
  const byKey = new Map<string, Article & { sources: Article['source'][] }>();
  for (const a of articles) {
    const key = urlKey(a.url);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...a, sources: [a.source] });
      continue;
    }
    if (!seen.sources.includes(a.source)) seen.sources.push(a.source);
    if ((a.snippet?.length ?? 0) > (seen.snippet?.length ?? 0)) seen.snippet = a.snippet;
    seen.publishedAt ??= a.publishedAt;
  }
  return [...byKey.values()]
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, MAX_ARTICLES);
}

/** An article as a potential match. It must be reviewed like any strong match. */
export function articleMatch(
  a: Article & { sources: Article['source'][] },
  terms: readonly string[],
): ProviderMatch {
  return {
    externalId: urlKey(a.url),
    name: a.title.slice(0, 500),
    score: null,
    strength: 'STRONG',
    categories: ['ADVERSE_MEDIA'],
    details: {
      kind: 'article',
      title: a.title,
      sourceUrl: a.url,
      domain: a.domain,
      ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}),
      ...(a.snippet ? { snippet: a.snippet } : {}),
      source: a.sources.map((s) => SOURCE_LABELS[s]).join(', '),
      terms: [...terms],
    },
  };
}
