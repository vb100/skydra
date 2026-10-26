import type { AppConfig } from '../config/env';

/**
 * The token is placed in the URL fragment: browsers never send the fragment to servers, so it
 * does not appear in access logs, proxies or Referer headers.
 */
export function linkUrl(config: AppConfig, token: string): string {
  return `${config.publicAppUrl}/activate#token=${token}`;
}
