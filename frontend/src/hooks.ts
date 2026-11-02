import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
export function usePageVisible() {
  return useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => true,
  );
}
// Used for user-triggered work that is not owned by a TanStack query observer.
export function useRequestLifetime() {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current?.abort();
  }, []);
  return useCallback(() => controller.current!.signal, []);
}
export function isAbort(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
