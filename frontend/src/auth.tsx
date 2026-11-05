import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Notice } from "./components/feedback";
import { Button } from "./components/ui/button";
import { useApp } from "./context";
import { supabase } from "./lib";
import { runAuthAction } from "./guestSession";
import { hasRecoveryAuthority, useRecoveryVersion } from "./recoveryAuth";
import { updateRecoveryPassword } from "./recoveryPassword";
import {
  AuthFlowError, authSchema, callbackFailure, checkSocialProvider, clearCallbackAddress,
  friendlyAuthError, providerName, redirectToProvider, safeReturnPath, unconsumedCallbackCode,
  type AuthFields, type AuthMode, type SocialProvider,
} from "./authSupport";

function ProviderMark({ provider }: { provider: SocialProvider }) {
  return provider === "google" ? (
    <svg className="provider-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.5a4.7 4.7 0 0 1-2 3v2.5h3.2c1.9-1.8 3.1-4.3 3.1-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.2-2.5c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.9v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.2 13.8a6 6 0 0 1 0-3.6V7.6H2.9a10 10 0 0 0 0 8.8l3.3-2.6Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.9.5 4 1.6l3-3A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9.1 5.6l3.3 2.6A6.1 6.1 0 0 1 12 5.9Z" />
    </svg>
  ) : (
    <svg className="provider-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#1877F2" d="M24 12a12 12 0 1 0-13.9 11.9v-8.4h-3V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.3 2.7.3v3h-1.5c-1.5 0-1.9.9-1.9 1.9V12h3.3l-.5 3.5h-2.8v8.4A12 12 0 0 0 24 12Z" />
    </svg>
  );
}

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { session, loading, getCaptchaToken } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [social, setSocial] = useState<SocialProvider>();
  const [recoveryCheck, setRecoveryCheck] = useState({ checked: false, error: "" });
  useRecoveryVersion();
  const active = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const currentMode = useRef(mode);
  currentMode.current = mode;
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<AuthFields>({
    resolver: zodResolver(authSchema(mode)),
    defaultValues: { fullName: "", email: "", password: "", confirmPassword: "" },
  });
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    generation.current += 1;
    active.current = false;
    setWorking(false); setSocial(undefined); setError(""); setMessage("");
    reset({ fullName: "", email: "", password: "", confirmPassword: "" });
    return () => { generation.current += 1; };
  }, [mode, reset]);
  useEffect(() => {
    if (mode !== "reset") return;
    let current = true;
    const callbackError = callbackFailure(window.location.href);
    setRecoveryCheck({ checked: false, error: "" });
    (async () => {
      if (!supabase) throw new AuthFlowError("AUTH_NOT_CONFIGURED");
      const initialized = await supabase.auth.initialize();
      if (initialized.error || callbackError || unconsumedCallbackCode()) throw new AuthFlowError("RECOVERY_LINK_INVALID");
      const result = await supabase.auth.getSession();
      if (result.error || !result.data.session || result.data.session.user.is_anonymous)
        throw new AuthFlowError("RECOVERY_LINK_INVALID");
      if (current) setRecoveryCheck({ checked: true, error: "" });
    })().catch((error: unknown) => {
      if (current) setRecoveryCheck({ checked: true, error: callbackError || friendlyAuthError(error) });
    }).finally(() => {
      // Keep the code until the constructor's one PKCE exchange has settled.
      if (current) clearCallbackAddress();
    });
    return () => { current = false; };
  }, [mode]);
  const headings: Record<AuthMode, string> = {
    login: "Welcome back.",
    register: "Create your account.",
    forgot: "Reset your password.",
    reset: "Choose a new password.",
  };
  const recoveryReady = mode !== "reset" || (recoveryCheck.checked && !recoveryCheck.error && !loading && hasRecoveryAuthority(session));
  const busy = working || isSubmitting || (mode === "reset" && !recoveryCheck.checked);
  const showSocial = mode === "login" || mode === "register";
  if (session && !session.user.is_anonymous && showSocial)
    return <Navigate to="/" replace />;

  async function submit(data: AuthFields) {
    if (active.current || currentMode.current !== mode) return;
    if (mode === "reset" && !recoveryReady) {
      setError(new AuthFlowError("RECOVERY_LINK_INVALID").message);
      return;
    }
    const started = generation.current;
    const isCurrent = () => alive.current && generation.current === started && currentMode.current === mode;
    active.current = true;
    setWorking(true); setSocial(undefined); setError(""); setMessage("");
    try {
      if (!supabase) throw new AuthFlowError("AUTH_NOT_CONFIGURED");
      const client = supabase;
      const captchaToken = mode === "reset" ? undefined : await getCaptchaToken();
      if (!isCurrent()) return;
      const outcome = await runAuthAction(async () => {
        if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
        if (showSocial) {
          const current = await client.auth.getSession();
          if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
          if (current.error) throw current.error;
          // An account may have signed in elsewhere while a bot check was open.
          if (current.data.session && !current.data.session.user.is_anonymous) return "signed-in";
        }
        if (mode === "login") {
          const result = await client.auth.signInWithPassword({
            email: data.email.trim(), password: data.password, options: { captchaToken },
          });
          if (result.error) throw result.error;
          if (!result.data.session) throw new AuthFlowError("AUTH_SESSION_MISSING");
          return "signed-in";
        }
        if (mode === "register") {
          const result = await client.auth.signUp({
            email: data.email.trim(), password: data.password,
            options: {
              data: { full_name: data.fullName.trim() },
              emailRedirectTo: window.location.origin + "/auth/callback",
              captchaToken,
            },
          });
          if (result.error) throw result.error;
          return result.data.session && !result.data.session.user.is_anonymous ? "signed-in" : "confirmation";
        }
        if (mode === "forgot") {
          const result = await client.auth.resetPasswordForEmail(data.email.trim(), {
            redirectTo: window.location.origin + "/reset-password", captchaToken,
          });
          if (result.error) throw result.error;
          return "reset-requested";
        }
        const initialized = await client.auth.initialize();
        if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
        if (initialized.error || unconsumedCallbackCode()) throw new AuthFlowError("RECOVERY_LINK_INVALID");
        const current = await client.auth.getSession();
        if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
        if (current.error || !hasRecoveryAuthority(current.data.session)) throw new AuthFlowError("RECOVERY_SESSION_CHANGED");
        await updateRecoveryPassword(current.data.session!, data.password);
        return "updated";
      });
      if (!isCurrent()) return;
      if (outcome === "signed-in") navigate(safeReturnPath(location.state?.from), { replace: true });
      else if (outcome === "updated") navigate("/settings", { replace: true });
      else setMessage(outcome === "confirmation"
        ? "Check your email for the confirmation link, then open it in this browser to finish creating your account."
        : "If this email can receive a reset link, it will arrive shortly. Open it in this browser.");
    } catch (exc) {
      if (isCurrent()) setError(friendlyAuthError(exc));
    } finally {
      if (isCurrent()) { active.current = false; setWorking(false); }
    }
  }

  async function continueWith(provider: SocialProvider) {
    if (active.current) return;
    const started = generation.current;
    const isCurrent = () => alive.current && generation.current === started && currentMode.current === mode;
    active.current = true;
    setWorking(true); setSocial(provider); setError(""); setMessage("");
    let leaving = false;
    try {
      if (!supabase) throw new AuthFlowError("AUTH_NOT_CONFIGURED");
      const client = supabase;
      const outcome = await runAuthAction(async () => {
        if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
        const current = await client.auth.getSession();
        if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
        if (current.error) throw current.error;
        if (current.data.session && !current.data.session.user.is_anonymous) return { signedIn: true };
        // Public provider availability only; no user token or provider secret is sent.
        await checkSocialProvider(provider);
        if (!isCurrent()) throw new DOMException("Cancelled", "AbortError");
        const result = await client.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: window.location.origin + "/auth/callback",
            scopes: provider === "google" ? "openid email profile" : "email",
            skipBrowserRedirect: true,
          },
        });
        if (result.error) throw result.error;
        if (!result.data.url) throw new AuthFlowError(provider === "google" ? "GOOGLE_START_FAILED" : "FACEBOOK_START_FAILED");
        return { url: result.data.url };
      });
      if (!isCurrent()) return;
      if (outcome.signedIn) navigate(safeReturnPath(location.state?.from), { replace: true });
      else {
        redirectToProvider(outcome.url!, provider);
        leaving = true;
        setMessage(`Opening ${providerName(provider)} sign-in…`);
      }
    } catch (exc) {
      if (isCurrent()) setError(friendlyAuthError(exc, provider));
    } finally {
      // The SDK-provided URL starts a top-level redirect; hold the guard until unload.
      if (!leaving && isCurrent()) {
        active.current = false;
        setWorking(false); setSocial(undefined);
      }
    }
  }

  function field(name: keyof AuthFields, label: string, type: string, autocomplete: string, placeholder?: string) {
    const issue = errors[name]?.message;
    return (
      <div className="auth-field">
        <label htmlFor={"account-" + name}>{label}</label>
        <input id={"account-" + name} type={type} autoComplete={autocomplete} placeholder={placeholder}
          required disabled={busy} maxLength={name === "fullName" ? 100 : name === "email" ? 254 : undefined}
          aria-invalid={!!issue} aria-describedby={issue ? "account-" + name + "-error" : undefined}
          {...register(name)} />
        {issue && <p className="field-error" id={"account-" + name + "-error"}>{issue}</p>}
      </div>
    );
  }

  return (
    <div className="auth-layout">
      <div className="auth-story">
        <div className="eyebrow"><span className="tiny-dot" />YOUR PERSONAL VIDEO SPACE</div>
        <h1>A little less scrolling.<br /><span>A little more keeping.</span></h1>
        <p>Bring your downloads together in one simple, private workspace.</p>
        <div className="auth-art">
          <div className="art-window"><span /><span /><span />
            <div className="art-play"><img src="/favicon.svg?v=red-1" alt="youtubedown" width={64} height={64} /></div>
            <div className="art-line" /><div className="art-line short" />
          </div>
          <span className="art-tag"><LockKeyhole size={15} />Just for you</span>
        </div>
      </div>
      <section className={"panel auth-panel" + (mode === "register" ? " register-panel" : "")}>
        <div className="icon-tile"><KeyRound size={23} /></div>
        <h2>{headings[mode]}</h2>
        <p className="muted">{mode === "register" ? "Four simple fields, or continue with an account below." : "A secure space for your downloads."}</p>
        {session?.user.is_anonymous && <Notice>Signing in or creating a separate account does not transfer your guest downloads. Finish saving any files you need first.</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice kind={social ? "info" : "success"}>{message}</Notice>}
        {mode === "reset" && (!recoveryCheck.checked || loading
          ? <Notice>Checking your password reset link…</Notice>
          : !recoveryReady && <Notice kind="error">{recoveryCheck.error || "Open a fresh password reset link in this browser to continue."} <Link to="/forgot-password">Request a new reset link</Link></Notice>)}
        {showSocial && <>
          <div className="social-auth" aria-label="Continue with a social account">
            {(["google", "facebook"] as const).map((provider) => (
              <button key={provider} type="button" className="oauth-button" disabled={busy || !supabase}
                aria-busy={social === provider && working} onClick={() => void continueWith(provider)}>
                {social === provider && working ? <LoaderCircle className="spin provider-mark" aria-hidden="true" /> : <ProviderMark provider={provider} />}
                {social === provider && working ? `Opening ${providerName(provider)}…` : `Continue with ${providerName(provider)}`}
              </button>
            ))}
          </div>
          <div className="auth-divider"><span>or use your email</span></div>
        </>}
        <form onSubmit={handleSubmit(submit)} className="form-stack" noValidate>
          {mode === "register" && field("fullName", "Full name", "text", "name", "Your name")}
          {mode !== "reset" && field("email", "Email address", "email", "email", "you@example.com")}
          {mode !== "forgot" && field("password", mode === "reset" ? "New password" : "Password", "password", mode === "login" ? "current-password" : "new-password")}
          {mode === "register" && field("confirmPassword", "Confirm password", "password", "new-password")}
          {(mode === "register" || mode === "reset") && <p className="field-hint">Use at least 8 characters for your password.</p>}
          {mode === "login" && <Link className="small-link" to="/forgot-password">Forgot password?</Link>}
          <Button disabled={busy || !supabase || !recoveryReady}>
            {busy && !social ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}
            {busy && !social ? "Please wait…" : mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Reset password"}
          </Button>
        </form>
        <p className="auth-switch"><Link to="/">Continue as guest</Link> · No login credentials required</p>
        <p className="auth-switch">{mode === "login" ? <>New to youtubedown? <Link to="/register">Create an account</Link></> : <Link to="/login">Back to sign in</Link>}</p>
      </section>
    </div>
  );
}

export function AuthCallback() {
  const { session, loading } = useApp();
  const [error, setError] = useState(() => callbackFailure(window.location.href));
  const [checkedUserId, setCheckedUserId] = useState("");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      if (alive) setSlow(true);
    }, 12000);
    (async () => {
      if (!supabase) throw new Error("not configured");
      // initialize() reuses the constructor's existing PKCE promise. Checking its
      // error matters: getSession alone can still return an older saved account.
      // Do not manually exchange the code or remove it before the SDK can read it.
      const initialized = await supabase.auth.initialize();
      if (initialized.error) throw initialized.error;
      if (unconsumedCallbackCode()) throw new AuthFlowError("CALLBACK_LINK_INVALID");
      const result = await supabase.auth.getSession();
      if (result.error) throw result.error;
      if (!result.data.session || result.data.session.user.is_anonymous) throw new AuthFlowError("CALLBACK_SESSION_MISSING");
      if (alive) {
        clearCallbackAddress();
        setCheckedUserId(result.data.session.user.id);
      }
    })().catch((error: unknown) => {
      if (alive) setError((existing) => existing || (error instanceof AuthFlowError
        ? error.message : "Sign-in could not be completed. Request a new link or try signing in again."));
    }).finally(() => {
      if (alive) clearCallbackAddress();
    });
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  const sessionMismatch = checkedUserId && !loading && (!session || session.user.is_anonymous || session.user.id !== checkedUserId);
  const failure = error || (sessionMismatch ? "The sign-in session changed. Please sign in again." : "");
  if (!failure && checkedUserId && session && !session.user.is_anonymous && !loading)
    return <Navigate to="/" replace />;
  return (
    <section className="panel compact-panel">
      <h1>{failure ? "Sign-in not completed" : "Completing sign-in…"}</h1>
      {failure ? <Notice kind="error">{failure} <Link to="/login">Sign in</Link> · <Link to="/">Continue as guest</Link></Notice> : <>
        <div role="status" aria-live="polite"><LoaderCircle className="spin" aria-hidden="true" /><span>Checking your account…</span></div>
        {slow && <Notice>Sign-in is taking longer than expected. Check your connection, <Link to="/login">try signing in again</Link>, or <Link to="/">continue as a guest</Link>.</Notice>}
      </>}
    </section>
  );
}

