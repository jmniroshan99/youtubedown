import { afterEach, describe, expect, it } from "vitest";
import {
  createQueryClient,
  clearPrivateState,
  privateKey,
} from "../src/queryClient";
import { privateRequestSignal } from "../src/requestScope";
const clients: ReturnType<typeof createQueryClient>[] = [];
function client() {
  const c = createQueryClient();
  clients.push(c);
  return c;
}
afterEach(() => {
  clients.forEach((c) => c.clear());
  clients.length = 0;
});
describe("private query boundaries", () => {
  it("keeps histories separate for different users and pages", () => {
    const q = client();
    q.setQueryData(privateKey("alice", "jobs", 0), ["alice-page1"]);
    q.setQueryData(privateKey("bob", "jobs", 0), ["bob-page1"]);
    q.setQueryData(privateKey("alice", "jobs", 30), ["alice-page2"]);
    expect(q.getQueryData(privateKey("alice", "jobs", 0))).toEqual([
      "alice-page1",
    ]);
    expect(q.getQueryData(privateKey("bob", "jobs", 0))).toEqual(["bob-page1"]);
    expect(q.getQueryData(privateKey("alice", "jobs", 30))).toEqual([
      "alice-page2",
    ]);
  });
  it("clears every private resource but retains public health on account changes", () => {
    const q = client();
    for (const resource of [
      "analysis",
      "provider-test",
      "jobs",
      "providers",
      "settings",
      "profile",
    ])
      q.setQueryData(privateKey("alice", resource), { private: true });
    q.setQueryData(["health"], { status: "ready" });
    clearPrivateState(q);
    expect(q.getQueryCache().findAll({ queryKey: ["private"] })).toHaveLength(
      0,
    );
    expect(q.getQueryData(["health"])).toEqual({ status: "ready" });
  });
  it("aborts private requests and creates a fresh signal for the next session", () => {
    const before = privateRequestSignal();
    clearPrivateState(client());
    expect(before.aborted).toBe(true);
    expect(privateRequestSignal().aborted).toBe(false);
    expect(privateRequestSignal()).not.toBe(before);
  });
  it("cancels a late query so its result cannot repopulate a signed-out cache", async () => {
    const q = client();
    let signal: AbortSignal | undefined;
    const request = q
      .fetchQuery({
        queryKey: privateKey("alice", "analysis"),
        queryFn: ({ signal: s }) => {
          signal = s;
          return new Promise((resolve) =>
            s.addEventListener("abort", () =>
              resolve({ title: "late private title" }),
            ),
          );
        },
      })
      .catch(() => undefined);
    clearPrivateState(q);
    await request;
    expect(signal?.aborted).toBe(true);
    expect(q.getQueryData(privateKey("alice", "analysis"))).toBeUndefined();
  });
  it("does not poll in the background or automatically retry mutations", () => {
    const options = client().getDefaultOptions();
    expect(options.queries?.refetchIntervalInBackground).toBe(false);
    expect(options.mutations?.retry).toBe(false);
  });
});
