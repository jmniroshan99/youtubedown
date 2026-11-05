import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useRef,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "./lib";
import { ensureGuestSession } from "./guestSession";
const CaptchaDialog = lazy(() => import("./components/CaptchaDialog"));
import { settingsOptions } from "./queries";
import { clearPrivateState } from "./queryClient";
import { observeRecoveryAuth } from "./recoveryAuth";

// Register while modules load so an initial recovery event is retained before
// lazy routes or account-switch remounts can subscribe to it.
observeRecoveryAuth(supabase?.auth);

type Theme = "light" | "dark";
const Context = createContext<{
  session: Session | null;
  loading: boolean;
  workspaceEpoch: number;
  ensureSession: () => Promise<Session>;
  getCaptchaToken: () => Promise<string | undefined>;
  theme: Theme;
  setTheme: (value: Theme) => void;
}>({
  session: null,
  loading: true,
  theme: "dark",
  setTheme: () => {},
  workspaceEpoch: 0,
  ensureSession: async () => {
    throw new Error("Session provider is unavailable.");
  },
  getCaptchaToken: async () => undefined,
});

function initialTheme(): Theme {
  try {
    return localStorage.getItem("vf-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
export function AppProvider({ children }: { children: ReactNode }) {
  const query = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!!supabase);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [challenge, setChallenge] = useState(false);
  const captcha = useRef<{
    promise: Promise<string>;
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const getCaptchaToken = useCallback((): Promise<string | undefined> => {
    if (!import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim())
      return Promise.resolve(undefined);
    if (captcha.current) return captcha.current.promise;
    let resolve!: (token: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    captcha.current = { promise, resolve, reject };
    setChallenge(true);
    return promise;
  }, []);
  const finishCaptcha = useCallback((token: string) => {
    captcha.current?.resolve(token);
    captcha.current = null;
    setChallenge(false);
  }, []);
  const cancelCaptcha = useCallback(() => {
    captcha.current?.reject(
      new Error("Verification was cancelled. You can try again."),
    );
    captcha.current = null;
    setChallenge(false);
  }, []);
  const ensureSession = useCallback(
    () => ensureGuestSession(getCaptchaToken),
    [getCaptchaToken],
  );
  useEffect(
    () => () => {
      captcha.current?.reject(new Error("Verification was cancelled."));
      captcha.current = null;
    },
    [],
  );
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const userId = session?.user.id;
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let currentUser: string | null | undefined;
    // INITIAL_SESSION supplies the first value; a second getSession request is unnecessary.
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      const nextUser = next?.user.id ?? null;
      if (currentUser !== nextUser) {
        clearPrivateState(query);
        // Keep the initiating home form mounted for the first visitor -> guest transition.
        // Subsequent account changes reset all route-local private state.
        if (currentUser) setWorkspaceEpoch((value) => value + 1);
        currentUser = nextUser;
      }
      setSession(next);
      setLoading(false);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [query]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = "en";
    try {
      localStorage.setItem("vf-theme", theme);
      // Retire the legacy local preference without touching profiles or server records.
      localStorage.removeItem("vf-language");
    } catch {
      /* Preferences still work when browser storage is restricted. */
    }
  }, [theme]);
  useEffect(() => {
    if (!userId || !supabase) return;
    let alive = true;
    void query
      .fetchQuery(settingsOptions(userId))
      .then((data) => {
        if (alive && data) setTheme(data.theme === "light" ? "light" : "dark");
      })
      .catch(() => {
        /* Keep device theme if preferences cannot be retrieved. */
      });
    return () => {
      alive = false;
    };
  }, [userId, query]);
  return (
    <Context.Provider
      value={{
        session,
        loading,
        theme,
        setTheme,
        workspaceEpoch,
        ensureSession,
        getCaptchaToken,
      }}
    >
      <div inert={challenge}>{children}</div>
      {challenge && (
        <Suspense
          fallback={
            <div role="status" className="verification-backdrop">
              Loading verification…
            </div>
          }
        >
          <CaptchaDialog onToken={finishCaptcha} onCancel={cancelCaptcha} />
        </Suspense>
      )}
    </Context.Provider>
  );
}
export function useApp() {
  return useContext(Context);
}
