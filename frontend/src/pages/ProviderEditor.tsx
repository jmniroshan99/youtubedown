import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Notice } from "../components/feedback";
import { Button } from "../components/ui/button";
import { useApp } from "../context";
import { useRequestLifetime } from "../hooks";
import { api, errorMessage, type Analysis, type Provider } from "../lib";
import { privateKey } from "../queryClient";

export default function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { session } = useApp();
  const userId = session?.user.id ?? "";
  const admin = session?.user.app_metadata?.role === "admin";
  const query = useQueryClient();
  const requestSignal = useRequestLifetime();
  const firstInput = useRef<HTMLInputElement>(null);
  const testStarted = useRef(0);
  const [testURL, setTestURL] = useState("");
  const [analysisId, setAnalysisId] = useState("");
  const [form, setForm] = useState(() => ({
    name: provider?.name ?? "",
    domains: provider?.domains.join(", ") ?? "",
    adapter_key: provider?.adapter_key ?? "yt_dlp",
    enabled: provider?.enabled ?? true,
  }));
  useEffect(() => {
    firstInput.current?.focus();
  }, []);
  const save = useMutation({
    mutationFn: () => {
      if (!admin) throw new Error("Administrator access is required.");
      return api("/api/providers" + (provider ? "/" + provider.id : ""), {
        method: provider ? "PUT" : "POST",
        signal: requestSignal(),
        body: JSON.stringify({
          ...form,
          domains: form.domains
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      });
    },
    onSuccess: () => {
      void query.invalidateQueries({
        queryKey: privateKey(userId, "providers"),
      });
      onSaved();
    },
  });
  const startTest = useMutation({
    mutationFn: () => {
      if (!admin || !provider)
        throw new Error("Save this provider before testing it.");
      return api<{ analysis_id: string }>(
        `/api/providers/${provider.id}/test`,
        {
          method: "POST",
          signal: requestSignal(),
          body: JSON.stringify({ url: testURL }),
        },
      );
    },
    onSuccess: (data) => {
      testStarted.current = Date.now();
      setAnalysisId(data.analysis_id);
    },
  });
  const test = useQuery({
    queryKey: privateKey(userId, "provider-test", analysisId),
    queryFn: ({ signal }) => {
      if (Date.now() - testStarted.current >= 180_000)
        throw new Error("The test timed out. Try again later.");
      return api<Analysis>(`/api/analyze/${analysisId}`, { signal });
    },
    enabled: admin && !!analysisId,
    refetchInterval: (result) =>
      result.state.data?.status === "queued" && result.state.status !== "error"
        ? 2_000
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (test.data?.status && test.data.status !== "queued")
      void query.invalidateQueries({
        queryKey: privateKey(userId, "providers"),
      });
  }, [test.data?.status, userId, query]);
  const testing =
    startTest.isPending ||
    (!!analysisId &&
      !test.isError &&
      (!test.data || test.data.status === "queued"));
  if (!admin) return null;
  return (
    <section className="panel provider-form" aria-labelledby="editor-heading">
      <div className="section-title">
        <h2 id="editor-heading">{provider ? "Edit source" : "New source"}</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close source editor"
        >
          <X size={18} />
        </Button>
      </div>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Name
          <input
            ref={firstInput}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Domains, separated by commas
          <input
            required
            placeholder="example.com, video.example.com"
            value={form.domains}
            onChange={(e) => setForm({ ...form, domains: e.target.value })}
          />
        </label>
        <label>
          Adapter
          <select
            value={form.adapter_key}
            onChange={(e) => setForm({ ...form, adapter_key: e.target.value })}
          >
            <option value="yt_dlp">Automatic (yt-dlp)</option>
            <option value="generic">Generic / embedded media</option>
            <option value="direct">Direct media URL</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enable this provider
        </label>
        <Button disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save source"}
        </Button>
        {save.isError && (
          <Notice kind="error">{errorMessage(save.error)}</Notice>
        )}
      </form>
      {provider && (
        <form
          className="test-source"
          onSubmit={(event) => {
            event.preventDefault();
            setAnalysisId("");
            startTest.mutate();
          }}
        >
          <label>
            Test a saved source URL
            <input
              type="url"
              required
              value={testURL}
              onChange={(e) => setTestURL(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <Button variant="secondary" disabled={testing || !testURL}>
            {testing && <LoaderCircle className="spin" size={16} />}
            {testing ? "Testing…" : "Test source"}
          </Button>
        </form>
      )}
      {(startTest.isError || test.isError) && (
        <Notice kind="error">
          {errorMessage(startTest.error || test.error)}
        </Notice>
      )}
      {test.data?.status === "completed" && (
        <Notice kind="success">
          The example URL works. Other videos may differ.
        </Notice>
      )}
      {test.data?.status === "failed" && (
        <Notice kind="error">
          The test failed. Check the URL and provider.
        </Notice>
      )}
      <p className="muted small-text">
        Adding a domain uses an existing adapter. A new extraction method needs
        a backend update.
      </p>
    </section>
  );
}
