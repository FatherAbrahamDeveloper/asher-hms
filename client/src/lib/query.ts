import { QueryClient, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { ApiError, get } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
});

/** Fetch an API path; the path is the cache key, so invalidating everything after a change refreshes every screen. */
export function useApi<T = any>(path: string | null, opts: Omit<UseQueryOptions<T>, "queryKey" | "queryFn"> = {}) {
  return useQuery<T>({ queryKey: [path], queryFn: () => get<T>(path!), enabled: !!path, ...opts });
}
