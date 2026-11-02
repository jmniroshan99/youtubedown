import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Busy, Notice } from "../components/feedback";
import { Button } from "../components/ui/button";
import { useApp } from "../context";
import { errorMessage, supabase } from "../lib";

import { Heading } from "../components/feedback";
import { profileOptions, settingsOptions } from "../queries";
import { privateRequestSignal } from "../requestScope";
export default function SettingsPage() {
  const { session, theme, setTheme } = useApp();
  const [name, setName] = useState<string | null>(null);
  const permanent = !!session && !session.user.is_anonymous;
  const userId = permanent ? session.user.id : "";
  const query = useQueryClient();
  const profile = useQuery({ ...profileOptions(userId), enabled: !!userId });
  const displayName = name ?? profile.data?.display_name ?? "";
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!permanent || !session || !supabase) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const results = await Promise.all([
        supabase
          .from("profiles")
          .upsert({
            id: session.user.id,
            display_name: displayName,
            updated_at: new Date().toISOString(),
          })
          .abortSignal(privateRequestSignal()),
        supabase
          .from("user_settings")
          .upsert({
            user_id: session.user.id,
            theme,
            updated_at: new Date().toISOString(),
          })
          .abortSignal(privateRequestSignal()),
      ]);
      for (const result of results) if (result.error) throw result.error;
      await Promise.all([
        query.invalidateQueries({ queryKey: profileOptions(userId).queryKey }),
        query.invalidateQueries({ queryKey: settingsOptions(userId).queryKey }),
      ]);
      setMessage("Preferences saved.");
    } catch (exc) {
      setError(errorMessage(exc));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="standard-page narrow">
      <Heading
        eyebrow={"MAKE YOURSELF AT HOME"}
        title={"Your preferences"}
        description={"A workspace that feels right for you."}
      />
      <form className="panel settings-panel form-stack" onSubmit={save}>
        <h2>{"Appearance"}</h2>
        <label>
          {"Theme"}
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as "dark" | "light")}
          >
            <option value="dark">{"Dark"}</option>
            <option value="light">{"Light"}</option>
          </select>
        </label>
        {permanent ? (
          <>
            <h2>{"Account"}</h2>
            {profile.isPending && <Busy />}
            {profile.isError && (
              <Notice kind="error">
                Could not load your profile.{" "}
                <button type="button" onClick={() => void profile.refetch()}>
                  Retry
                </button>
              </Notice>
            )}
            <label>
              {"Display name"}
              <input
                maxLength={100}
                value={displayName}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {"Email"}
              <input readOnly value={session.user.email || ""} />
            </label>
            <Button disabled={busy || profile.isPending || profile.isError}>
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              {"Save preferences"}
            </Button>
            <Link className="small-link" to="/forgot-password">
              {"Change password"}
            </Link>
          </>
        ) : (
          <Notice>
            {
              "Your display preferences are saved on this device. Sign in to sync them."
            }{" "}
            <Link to="/login">{"Sign in"}</Link>
          </Notice>
        )}
        {message && <Notice kind="success">{message}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
      </form>
    </div>
  );
}
