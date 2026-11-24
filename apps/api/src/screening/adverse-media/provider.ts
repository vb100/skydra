import { RuleError } from '../../domain-errors';
import {
  ProviderError,
  type ProviderExchange,
  type ProviderResult,
  type ScreeningProvider,
  type ScreeningSubject,
} from '../provider';
import { articleMatch, combine } from './articles';
import { highlightTerms, nameVariants } from './queries';
import type { MediaSource } from './sources';

/**
 * One check per person covers the lists and the media (client specification, modules A and B):
 * the list provider and every media source are asked in parallel, and the articles found are
 * added to the list matches as ADVERSE_MEDIA matches.
 *
 * If any source fails, the whole check is FAILED (never "nothing found"), with the attempts of
 * every source kept as evidence. A partial result would look complete to the broker.
 */
export class WithAdverseMedia implements ScreeningProvider {
  readonly mode: ScreeningProvider['mode'];
  readonly sources: readonly string[];

  constructor(
    private readonly lists: ScreeningProvider,
    private readonly media: readonly MediaSource[],
  ) {
    this.mode = lists.mode;
    this.sources = [...(lists.sources ?? [lists.mode]), ...media.map((m) => m.code)];
  }

  async screen(subject: ScreeningSubject): Promise<ProviderResult> {
    const [[lists], media] = await Promise.all([
      Promise.allSettled([this.lists.screen(subject)]),
      Promise.allSettled(this.media.map((m) => m.search(subject))),
    ]);

    const exchanges: ProviderExchange[] = [];
    const errors: string[] = [];
    for (const outcome of [lists!, ...media]) {
      if (outcome.status === 'fulfilled') {
        exchanges.push(...(outcome.value.exchanges ?? []));
        continue;
      }
      // A configuration problem is not an outage: it is reported as such, without a check.
      if (outcome.reason instanceof RuleError) throw outcome.reason;
      if (outcome.reason instanceof ProviderError) exchanges.push(...outcome.reason.exchanges);
      errors.push(
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      );
    }
    if (lists!.status !== 'fulfilled' || errors.length > 0)
      throw new ProviderError(errors.join('; '), exchanges);

    const names = nameVariants(subject);
    const terms = highlightTerms([...new Set([...names.lt, ...names.en])]);
    const articles = combine(
      media.flatMap((m) => (m.status === 'fulfilled' ? m.value.articles : [])),
    ).map((a) => articleMatch(a, terms));
    return {
      reference: lists!.value.reference,
      matches: [...lists!.value.matches, ...articles],
      exchanges,
    };
  }
}
