import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { CaseListItem } from './types';

/** The cases the member can see (shared by the case list, the work list and the dashboard). */
export function useCases() {
  return useQuery({
    queryKey: ['cases'],
    queryFn: () => api<CaseListItem[]>('GET', '/cases'),
  });
}

/** Link to a case, opened on the tab where its next step is done. */
export const caseLink = (id: string, tab?: string) =>
  tab && tab !== 'overview' ? `/cases/${id}?tab=${tab}` : `/cases/${id}`;
