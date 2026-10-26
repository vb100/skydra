import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Me } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('GET', '/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useRefreshMe() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['me'] });
}

/** Translated message for an API error code. */
export function useErrorMessage() {
  const { t } = useTranslation();
  return (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.code === 'forbidden' && error.detail) return error.detail;
      return t(`errors.${error.code}`, { defaultValue: t('errors.unknown') });
    }
    return t('errors.unknown');
  };
}

/** Brokers and managers work on cases (mirrors access/policy.ts; for navigation only). */
export function caseWorker(roles: string[]): boolean {
  return roles.includes('BROKER') || roles.includes('MANAGER');
}
