import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  Globe2,
  Link2,
  ListVideo,
  Menu,
  Moon,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Busy, Notice } from "./components/feedback";
import { ServiceStatus } from "./components/ServiceStatus";
import { Button } from "./components/ui/button";
import { useApp } from "./context";
import { configurationError, errorMessage, supabase } from "./lib";
import Home from "./pages/Home";
import { useServiceReady } from "./queries";
import { runAuthAction } from "./guestSession";
const Downloads = lazy(() => import("./pages/Downloads"));
const Providers = lazy(() => import("./pages/Providers"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const Help = lazy(() => import("./pages/Help"));
const AuthPage = lazy(() =>
  import("./auth").then((m) => ({ default: m.AuthPage })),
);
const AuthCallback = lazy(() =>
  import("./auth").then((m) => ({ default: m.AuthCallback })),
);

function Guard({ children }: { children: ReactNode }) {
  const { session, loading, ensureSession } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (loading) return <Busy />;
  if (session) return children;
  return (
    <section className="panel compact-panel">
      <h1>Open your guest workspace</h1>
      <p>
        Continue without an email address or password. Your downloads stay
        private to this browser session.
      </p>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await ensureSession();
          } catch (exc) {
            setError(errorMessage(exc));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Starting guest session…" : "Continue as guest"}
      </Button>
      {error && <Notice kind="error">{error}</Notice>}
      <p>
        <Link to="/login">Sign in to an existing account</Link>
      </p>
    </section>
  );
}
export default function App() {
  const { session, theme, setTheme, workspaceEpoch } = useApp();
  const guest = !!session?.user.is_anonymous;
  const [signOutError, setSignOutError] = useState("");
  const [mobile, setMobile] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [smallScreen, setSmallScreen] = useState(
    () => window.matchMedia("(max-width: 800px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 800px)");
    const resize = () => setSmallScreen(media.matches);
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        menuButton.current?.getAttribute("aria-expanded") === "true"
      ) {
        setMobile(false);
        menuButton.current.focus();
      }
    };
    media.addEventListener("change", resize);
    window.addEventListener("keydown", escape);
    return () => {
      media.removeEventListener("change", resize);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  const location = useLocation();
  const query = useQueryClient();
  const ready = useServiceReady();
  const navigation = [
    { path: "/", icon: Link2, label: "New download" },
    {
      path: "/downloads",
      icon: ListVideo,
      label: "Current downloads",
    },
    {
      path: "/sources",
      icon: Globe2,
      label: "Video sources",
    },
  ];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobile && (
        <button
          className="nav-shade"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-navigation"
        inert={smallScreen && !mobile}
        className={`sidebar ${mobile ? "open" : ""}`}
      >
        <Link to="/" className="brand" aria-label="youtubedown home" onClick={() => setMobile(false)}>
          <img className="brand-mark" src="/favicon.svg?v=red-1" width={34} height={34} alt="" aria-hidden="true" />
          youtube<span>down</span>
          <span className="brand-dot" />
        </Link>
        <div className="nav-caption">{"YOUR WORKSPACE"}</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ path, icon: Icon, label }) => (
            <NavLink
              key={path}
              to={path}
              end
              onClick={() => setMobile(false)}
              className={({ isActive }) =>
                isActive ? "nav-item active" : "nav-item"
              }
            >
              <Icon size={19} />
              {label}
              {path === "/" && <span className="nav-plus">+</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-card">
            <div className="shield-circle">
              <ShieldCheck size={20} />
            </div>
            <strong>{"Your files. Your space."}</strong>
            <p>{"Private downloads with links that expire automatically."}</p>
            <span>
              <span className="tiny-dot" />
              {"Private by design"}
            </span>
          </div>
          <NavLink
            to="/settings"
            onClick={() => setMobile(false)}
            className="nav-item"
          >
            <Settings2 size={19} />
            {"Settings"}
          </NavLink>
          <NavLink
            to="/help"
            onClick={() => setMobile(false)}
            className="nav-item"
          >
            <CircleHelp size={19} />
            {"Help & support"}
            <ArrowUpRight size={15} className="push" />
          </NavLink>
          <div className="sidebar-footer">
            youtubedown <span>v1.5.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <Button
            variant="ghost"
            size="icon"
            className="mobile-menu"
            ref={menuButton}
            aria-label={mobile ? "Close navigation" : "Open navigation"}
            aria-expanded={mobile}
            aria-controls="workspace-navigation"
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X size={21} /> : <Menu size={21} />}
          </Button>
          <Link to="/" className="mobile-brand" aria-label="youtubedown home" onClick={() => setMobile(false)}>
            <img className="mobile-brand-mark" src="/favicon.svg?v=red-1" width={30} height={30} alt="" aria-hidden="true" />
          </Link>
          <div className="breadcrumb">
            <span>{"Workspace"}</span>
            <ChevronRight size={14} />
            <strong>
              {location.pathname === "/"
                ? "New download"
                : (
                    {
                      downloads: "Current downloads",
                      sources: "Video sources",
                      settings: "Settings",
                      help: "Help",
                      login: "Sign in",
                      register: "Register",
                    } as Record<string, string>
                  )[location.pathname.split("/")[1]] || "Account"}
            </strong>
          </div>
          <div className="top-actions">
            <ServiceStatus />
            <Button
              variant="ghost"
              size="icon"
              aria-label={"Toggle theme"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            {session && !guest ? (
              <Button
                variant="secondary"
                size="small"
                onClick={async () => {
                  setSignOutError("");
                  const result = await runAuthAction(() =>
                    supabase!.auth.signOut(),
                  );
                  if (result.error) setSignOutError(errorMessage(result.error));
                  else query.clear();
                }}
              >
                {"Sign out"}
              </Button>
            ) : (
              <Button asChild size="small">
                <Link to="/login">
                  {"Sign in"}
                  <ArrowUpRight size={15} />
                </Link>
              </Button>
            )}
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {configurationError && (
            <Notice kind="error">
              {
                "Supabase is not configured. Follow START_HERE.md to connect your project."
              }
            </Notice>
          )}
          {signOutError && <Notice kind="error">{signOutError}</Notice>}
          {guest && (
            <aside className="guest-banner" aria-label="Guest workspace">
              <strong>Guest workspace</strong>
              <span>
                Your downloads belong to this session. Clearing browser data or
                leaving this session can make current jobs inaccessible. Prepared files expire automatically.
              </span>
              <Link to="/login">Sign in</Link>
            </aside>
          )}
          <Suspense fallback={<Busy />}>
            <Routes key={workspaceEpoch}>
              <Route path="/" element={<Home serviceReady={ready} />} />
              <Route
                path="/downloads"
                element={
                  <Guard>
                    <Downloads />
                  </Guard>
                }
              />
              <Route
                path="/sources"
                element={
                  <Guard>
                    <Providers />
                  </Guard>
                }
              />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/help" element={<Help />} />
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/register" element={<AuthPage mode="register" />} />
              <Route
                path="/forgot-password"
                element={<AuthPage mode="forgot" />}
              />
              <Route
                path="/reset-password"
                element={<AuthPage mode="reset" />}
              />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route
                path="*"
                element={
                  <div className="empty-state">
                    <h1>404</h1>
                    <p>{"This page could not be found."}</p>
                    <Button asChild>
                      <Link to="/">{"Back to home"}</Link>
                    </Button>
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </main>
        <footer className="page-footer">
          <span>© {new Date().getFullYear()} youtubedown</span>
          <span>
            <ShieldCheck size={14} />
            {"Only download content you own or have permission to save."}
          </span>
          <Link to="/help">{"Help"}</Link>
        </footer>
      </div>
    </div>
  );
}
