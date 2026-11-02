import { QueryClient } from "@tanstack/react-query";
import { resetPrivateRequests } from "./requestScope";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
      },
      mutations: { retry: false },
    },
  });
}
export const privateKey = (
  userId: string,
  resource: string,
  ...parts: (string | number)[]
) => ["private", userId, resource, ...parts] as const;

export function clearPrivateState(query: QueryClient) {
  resetPrivateRequests();
  void query.cancelQueries({ queryKey: ["private"] });
  query.removeQueries({ queryKey: ["private"] });
  query.getMutationCache().clear();
}
