import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  admin: false,
  editorLoaded: vi.fn(),
  api: vi.fn(),
}));
vi.mock("../src/context", () => ({
  useApp: () => ({
    session: {
      user: {
        id: "test-user",
        app_metadata: { role: mocks.admin ? "admin" : "user" },
      },
    },
  }),
}));
vi.mock("../src/lib", () => ({
  api: mocks.api,
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("../src/pages/ProviderEditor", () => {
  mocks.editorLoaded();
  return { default: () => <div>Source editor loaded</div> };
});
import Providers from "../src/pages/Providers";
import { createQueryClient } from "../src/queryClient";
const q = createQueryClient();
function renderPage() {
  return render(
    <QueryClientProvider client={q}>
      <MemoryRouter>
        <Providers />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.admin = false;
  mocks.api
    .mockReset()
    .mockResolvedValue([
      {
        id: "source-1",
        name: "Example",
        domains: ["example.com"],
        enabled: true,
        support_status: "unknown",
        last_checked_at: null,
      },
    ]);
});
afterEach(() => {
  cleanup();
  q.clear();
});
describe("conditional provider administration", () => {
  it("does not expose or load the editor for regular users", async () => {
    renderPage();
    await screen.findByText("Example");
    expect(screen.queryByText("Add website")).toBeNull();
    expect(screen.queryByText("Manage")).toBeNull();
    expect(mocks.editorLoaded).not.toHaveBeenCalled();
  });
  it("loads the editor only after an administrator opens it", async () => {
    mocks.admin = true;
    renderPage();
    await screen.findByText("Example");
    expect(mocks.editorLoaded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() =>
      expect(screen.getByText("Source editor loaded")).toBeTruthy(),
    );
    expect(mocks.editorLoaded).toHaveBeenCalledOnce();
  });
});
