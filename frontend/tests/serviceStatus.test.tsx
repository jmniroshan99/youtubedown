import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  ServiceConnection,
  ServiceStatus,
} from "../src/components/ServiceStatus";
import { useServiceReady } from "../src/queries";
vi.hoisted(() => { vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test"); });
function ReadyState() {
  return <span data-testid="ready-state">{String(useServiceReady())}</span>;
}
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("does not keep claiming online when a fresh check fails after an earlier success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
  );
  const client = new QueryClient();
  client.setQueryData(["health"], { status: "ready" });
  render(
    <QueryClientProvider client={client}>
      <ServiceStatus />
      <ServiceConnection />
      <ReadyState />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Service online" })).toBeTruthy();
  await act(() => client.refetchQueries({ queryKey: ["health"] }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Service online" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Check connection" })).toBeTruthy();
  expect(screen.getByTestId("ready-state").textContent).toBe("false");
  expect(fetch).toHaveBeenCalledOnce();
  client.clear();
});
