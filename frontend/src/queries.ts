import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiBase, ApiError, supabase, checkApiBase } from "./lib";
import { privateKey } from "./queryClient";

export const healthOptions = queryOptions({
  queryKey: ["health"],
  queryFn: async ({ signal }) => {
    if (checkApiBase(apiBase)) return { status: "not_configured" };
    const response = await fetch(apiBase + "/health", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      cache: "no-store",
    });
    const data = await response.json().catch(() => null);
    if (
      !response.headers.get("content-type")?.includes("application/json") ||
      !data ||
      typeof data.status !== "string" ||
      (data.status === "ready" && !response.ok)
    )
      return { status: "invalid_response" };
    return { status: data.status as string };
  },
  staleTime: 60_000,
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
  retry: false,
});
export function useServiceHealth() {
  return useQuery(healthOptions);
}
export function useServiceReady() {
  const health = useQuery({
    ...healthOptions,
    select: (data) => data.status === "ready",
    notifyOnChangeProps: ["data", "isError"],
  });
  return !health.isError && (health.data ?? false);
}
export function settingsOptions(userId: string) {
  return queryOptions({
    queryKey: privateKey(userId, "settings"),
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      if (!supabase) throw new ApiError("Supabase configuration is missing.");
      const { data, error } = await supabase
        .from("user_settings")
        .select("theme,language")
        .eq("user_id", userId)
        .abortSignal(signal)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
export function profileOptions(userId: string) {
  return queryOptions({
    queryKey: privateKey(userId, "profile"),
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      if (!supabase) throw new ApiError("Supabase configuration is missing.");
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", userId)
        .abortSignal(signal)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
