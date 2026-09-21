import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionView } from '@jce/shared';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  data?: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const body = (await response.json()) as T & {
    error?: { message: string; fields?: string[] };
  };
  if (!response.ok)
    throw new ApiError(
      response.status,
      `${body.error?.message ?? 'Request failed.'}${body.error?.fields?.length ? ' Fields: ' + body.error.fields.join(', ') : ''}`,
    );
  return body;
}
type Auth = {
  session: SessionView | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  write: <T>(path: string, data?: unknown, method?: string) => Promise<T>;
};
const Context = createContext<Auth | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api<SessionView>('/auth/session');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
    refetchInterval: 30000,
  });
  const refresh = async () => {
    await client.invalidateQueries();
  };
  const write = async <T,>(
    path: string,
    data?: unknown,
    method = 'POST',
  ): Promise<T> => {
    try {
      const result = await api<T>(path, method, data, query.data?.csrfToken);
      await refresh();
      return result;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 423].includes(error.status))
        await query.refetch();
      throw error;
    }
  };
  return (
    <Context.Provider
      value={{
        session: query.data ?? null,
        loading: query.isPending,
        error: query.error,
        refresh,
        write,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const context = useContext(Context);
  if (!context) throw new Error('Missing session provider.');
  return context;
}
export function useData<T>(path: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: [
      'data',
      session?.user.id,
      session?.csrfToken,
      session?.permissions.join(','),
      session?.branchId,
      path,
    ],
    queryFn: () => api<T>(path),
    retry: false,
  });
}
export function useAllowed(permission: string) {
  return useSession().session?.permissions.includes(permission) ?? false;
}
