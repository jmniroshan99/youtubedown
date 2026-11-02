import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Notice } from "./feedback";

type Turnstile = {
  ready: (callback: () => void) => void;
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
let loader: Promise<Turnstile> | undefined;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loader)
    loader = new Promise<Turnstile>((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      const timeout = window.setTimeout(() => fail(), 15000);
      function fail() {
        clearTimeout(timeout);
        script.remove();
        loader = undefined;
        reject(
          new Error(
            "Verification could not load. Check your connection, then try again.",
          ),
        );
      }
      script.onerror = fail;
      script.onload = () => {
        clearTimeout(timeout);
        if (window.turnstile) resolve(window.turnstile);
        else fail();
      };
      document.head.appendChild(script);
    });
  return loader;
}
export default function CaptchaDialog({
  onToken,
  onCancel,
}: {
  onToken: (token: string) => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let widget: string | undefined;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>(
        'button, iframe, [tabindex="0"]',
      );
      if (!controls?.length) return;
      const first = controls[0],
        last = controls[controls.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keyboard);
    void loadTurnstile()
      .then((api) =>
        api.ready(() => {
          if (!alive || !host.current) return;
          try {
            widget = api.render(host.current, {
              sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
              theme: "auto",
              size: "flexible",
              language: "en",
              callback: (token: string) => {
                if (alive) onToken(token);
              },
              "error-callback": () => {
                if (alive)
                  setError(
                    "Verification failed. Close this window and try again.",
                  );
              },
              "expired-callback": () => {
                if (alive)
                  setError(
                    "Verification expired. Close this window and try again.",
                  );
              },
            });
          } catch {
            if (alive)
              setError(
                "Verification could not start. Close this window and try again.",
              );
          }
        }),
      )
      .catch((exc: Error) => {
        if (alive) setError(exc.message);
      });
    return () => {
      alive = false;
      document.removeEventListener("keydown", keyboard);
      if (widget !== undefined) window.turnstile?.remove(widget);
      if (previous?.isConnected) previous.focus();
    };
  }, [onToken, onCancel]);
  return (
    <div className="verification-backdrop">
      <div
        ref={dialog}
        className="panel verification-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="verification-title"
        tabIndex={-1}
      >
        <h2 id="verification-title">Quick verification</h2>
        <p>
          Please complete this check to continue. No login details are needed
          for guest access.
        </p>
        <div ref={host} aria-label="Security verification" />
        {error && <Notice kind="error">{error}</Notice>}
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
