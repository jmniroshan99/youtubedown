import { useQuery } from "@tanstack/react-query";
import { usePageVisible } from "./hooks";
import { api, type Job } from "./lib";
import { privateKey } from "./queryClient";

export const activeStatuses = ["queued", "downloading", "processing", "uploading"];

export function jobsPollInterval(jobs: Job[] | undefined, failed: boolean) {
  if (failed) return 30_000;
  return jobs?.some((job) => activeStatuses.includes(job.status)) ? 5_000 : 30_000;
}

export function useDownloadJobs(userId: string, offset: number) {
  const visible = usePageVisible();
  // Jobs now live in Redis with a TTL. Database Realtime cannot observe them.
  // Visible, bounded polling is the fallback and never opens a database channel.
  return useQuery({
    queryKey: privateKey(userId, "jobs", offset),
    queryFn: ({ signal }) => api<Job[]>(`/api/downloads?offset=${offset}`, { signal }),
    enabled: !!userId,
    staleTime: 4_000,
    refetchInterval: (result) => visible ? jobsPollInterval(result.state.data, result.state.status === "error") : false,
    refetchIntervalInBackground: false,
  });
}
