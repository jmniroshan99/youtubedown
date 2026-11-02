import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CaptchaDialog from "../src/components/CaptchaDialog";
let options: Record<string, unknown>;
const remove = vi.fn();
beforeEach(() => {
  remove.mockClear();
  window.turnstile = {
    ready: (callback) => callback(),
    render: vi.fn((_host, args) => {
      options = args;
      return "test-widget";
    }),
    remove,
  };
});
afterEach(() => {
  cleanup();
  delete window.turnstile;
});
it("returns a verified token and removes its widget on close", async () => {
  const token = vi.fn();
  const view = render(<CaptchaDialog onToken={token} onCancel={vi.fn()} />);
  await waitFor(() => expect(window.turnstile?.render).toHaveBeenCalledOnce());
  act(() =>
    (options.callback as (token: string) => void)("test-captcha-token"),
  );
  expect(token).toHaveBeenCalledExactlyOnceWith("test-captcha-token");
  view.unmount();
  expect(remove).toHaveBeenCalledExactlyOnceWith("test-widget");
});
it("shows verification failure without success and supports keyboard cancellation", async () => {
  const token = vi.fn(),
    cancel = vi.fn();
  render(<CaptchaDialog onToken={token} onCancel={cancel} />);
  await waitFor(() => expect(window.turnstile?.render).toHaveBeenCalledOnce());
  act(() => (options["error-callback"] as () => void)());
  expect(screen.getByText(/Verification failed/)).toBeTruthy();
  expect(token).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(cancel).toHaveBeenCalledOnce();
});
it("handles an asynchronous widget-rendering failure", async () => {
  let ready!: () => void;
  window.turnstile!.ready = (callback) => {
    ready = callback;
  };
  window.turnstile!.render = () => {
    throw new Error("Invalid site key");
  };
  render(<CaptchaDialog onToken={vi.fn()} onCancel={vi.fn()} />);
  await waitFor(() => expect(ready).toBeTypeOf("function"));
  act(() => ready());
  expect(screen.getByText(/Verification could not start/)).toBeTruthy();
});
