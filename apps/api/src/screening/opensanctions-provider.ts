import type { MatchCategory } from '@skydra/shared';
import { z } from 'zod';
import { callWithRetry, type HttpOptions } from './http-exchange';
import {
  ProviderError,
  type ProviderMatch,
  type ProviderResult,
  type ScreeningProvider,
  type ScreeningSubject,
} from './provider';

/**
 * OpenSanctions hosted API (https://www.opensanctions.org/docs/api/): one POST /match query per
 * person or company checks sanctions, PEPs and other risk lists at once.
 *
 * Only what the check needs is sent: name, birth date and nationality for a person; name,
 * company code and jurisdiction for a company. The personal code never is.
 */
export type OpenSanctionsOptions = HttpOptions & {
  apiKey: string;
  baseUrl: string;
  /** Score (0–1) from which the API reports `match: true`; those become STRONG matches. */
  threshold: number;
  dataset?: string;
  limit?: number;
};

const QUERY_ID = 'q';

const Result = z.object({
  id: z.string(),
  caption: z.string(),
  schema: z.string(),
  properties: z.record(z.string(), z.array(z.unknown())).default({}),
  datasets: z.array(z.string()).default([]),
  score: z.number(),
  match: z.boolean(),
  first_seen: z.string().nullish(),
  last_seen: z.string().nullish(),
});
const MatchResponse = z.object({
  responses: z.record(
    z.string(),
    z.object({ status: z.number().default(200), results: z.array(Result) }),
  ),
});
type Result = z.infer<typeof Result>;

/**
 * OpenSanctions topics to our categories. A sanctioned entity and one it controls are both
 * SANCTIONS (asset freezes reach owned or controlled companies); other risk topics need a review
 * as OTHER_LIST. Counter-sanctions (lists of e.g. activists kept by sanctioned regimes) are not a
 * risk and are left out.
 */
export function categoriesOf(topics: readonly string[]): MatchCategory[] {
  const found = new Set<MatchCategory>();
  for (const topic of topics) {
    if (topic === 'sanction' || topic === 'sanction.control') found.add('SANCTIONS');
    else if (topic === 'role.pep') found.add('PEP');
    else if (topic === 'role.rca') found.add('PEP_ASSOCIATE');
    else if (
      topic === 'sanction.linked' ||
      topic === 'debarment' ||
      topic === 'poi' ||
      topic === 'wanted' ||
      topic === 'corp.disqual' ||
      topic.startsWith('crime') ||
      topic.startsWith('reg.')
    )
      found.add('OTHER_LIST');
  }
  // Every stored match has a category; a result without a known risk topic still gets reviewed.
  return found.size > 0 ? [...found] : ['OTHER_LIST'];
}

/** The /match query for one subject (OpenSanctions uses lower-case ISO country codes). */
export function queryFor(subject: ScreeningSubject) {
  const countries = subject.countries.map((c) => c.toLowerCase());
  const properties: Record<string, string[]> =
    subject.partyType === 'NATURAL'
      ? {
          name: [subject.name],
          ...(subject.birthDate ? { birthDate: [subject.birthDate] } : {}),
          ...(countries.length ? { nationality: countries } : {}),
        }
      : {
          name: [subject.name],
          ...(subject.registrationNumber
            ? { registrationNumber: [subject.registrationNumber] }
            : {}),
          ...(countries.length ? { jurisdiction: countries } : {}),
        };
  return {
    queries: {
      [QUERY_ID]: { schema: subject.partyType === 'NATURAL' ? 'Person' : 'Company', properties },
    },
  };
}

const strings = (values: unknown[] | undefined) =>
  (values ?? []).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

/** Flat, readable fields for the reviewer; the full record stays in screening_requests. */
function detailsOf(r: Result): Record<string, string> {
  const p = r.properties;
  const topics = strings(p.topics);
  const details: Record<string, string | undefined> = {
    topics: topics.join(', ') || undefined,
    position: strings(p.position).slice(0, 3).join('; ') || undefined,
    birthDate: strings(p.birthDate).join(', ') || undefined,
    nationality:
      strings(p.nationality ?? p.citizenship)
        .join(', ')
        .toUpperCase() || undefined,
    country:
      strings(p.country ?? p.jurisdiction)
        .join(', ')
        .toUpperCase() || undefined,
    registrationNumber: strings(p.registrationNumber).join(', ') || undefined,
    datasets: r.datasets.join(', ') || undefined,
    sourceUrl: strings(p.sourceUrl)[0],
    entityUrl: `https://www.opensanctions.org/entities/${encodeURIComponent(r.id)}/`,
  };
  return Object.fromEntries(
    Object.entries(details).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

export function matchOf(r: Result): ProviderMatch {
  return {
    externalId: r.id,
    name: r.caption,
    score: Math.round(r.score * 10000) / 100,
    strength: r.match ? 'STRONG' : 'WEAK',
    categories: categoriesOf(strings(r.properties.topics)),
    details: detailsOf(r),
  };
}

export class OpenSanctionsProvider implements ScreeningProvider {
  readonly mode = 'OPENSANCTIONS' as const;
  readonly sources = ['OPENSANCTIONS'] as const;

  constructor(private readonly options: OpenSanctionsOptions) {}

  async screen(subject: ScreeningSubject): Promise<ProviderResult> {
    const { baseUrl, apiKey, threshold } = this.options;
    const dataset = this.options.dataset ?? 'default';
    const params = new URLSearchParams({
      algorithm: 'best',
      threshold: String(threshold),
      limit: String(this.options.limit ?? 10),
    });
    const body = queryFor(subject);
    const outcome = await callWithRetry(
      {
        provider: 'OPENSANCTIONS',
        url: `${baseUrl}/match/${encodeURIComponent(dataset)}?${params}`,
        method: 'POST',
        headers: {
          Authorization: `ApiKey ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        logged: { url: `/match/${dataset}?${params}`, body },
      },
      this.options,
    );
    const { exchanges } = outcome;
    if (!outcome.ok) throw new ProviderError(`OpenSanctions: ${outcome.error}`, exchanges);

    const parsed = MatchResponse.safeParse(outcome.json);
    const answer = parsed.success ? parsed.data.responses[QUERY_ID] : undefined;
    if (answer && answer.status === 200)
      return { reference: null, matches: answer.results.map(matchOf), exchanges };
    const error = parsed.success
      ? `query status ${answer?.status ?? 'missing'}`
      : 'unexpected response';
    exchanges.at(-1)!.error = error;
    throw new ProviderError(`OpenSanctions: ${error}`, exchanges);
  }
}
