import type { AppConfig } from '../../config/env';
import type { ScreeningProvider } from '../provider';
import { WithAdverseMedia } from './provider';
import { BraveSource, GdeltSource, type MediaSource } from './sources';

export { WithAdverseMedia } from './provider';
export { BraveSource, GdeltSource, type MediaSource } from './sources';

/** The list provider, with the configured media sources searched alongside it. */
export function withMedia(
  lists: ScreeningProvider,
  config: AppConfig['adverseMedia'],
): ScreeningProvider {
  const media: MediaSource[] = [];
  if (config.brave) media.push(new BraveSource(config.brave));
  if (config.gdelt) media.push(new GdeltSource(config.gdelt));
  return media.length > 0 ? new WithAdverseMedia(lists, media) : lists;
}
