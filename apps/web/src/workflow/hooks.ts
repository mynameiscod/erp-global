import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

/** How many approvals wait for me (or for people I stand in for). */
export function useApprovalCount() {
  const { status, isPlatform } = useAuth();
  return useQuery({
    queryKey: ['approvals', 'count'],
    queryFn: () => api<{ pending: number }>('/workflow/tasks/count'),
    enabled: status === 'authenticated' && !isPlatform,
    refetchInterval: 60_000,
  });
}
