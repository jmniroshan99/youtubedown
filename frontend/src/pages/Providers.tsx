import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Globe2,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import { Busy, Notice } from "../components/feedback";
import { Button } from "../components/ui/button";
import { useApp } from "../context";
import { api, errorMessage, type Provider } from "../lib";

import { Heading } from "../components/feedback";
import { privateKey } from "../queryClient";
const ProviderEditor = lazy(() => import("./ProviderEditor"));
export default function Providers() {
  const { session } = useApp();
  const userId = session?.user.id ?? "";
  const isAdmin =
    !session?.user.is_anonymous && session?.user.app_metadata?.role === "admin";
  const providers = useQuery({
    queryKey: privateKey(userId, "providers"),
    queryFn: ({ signal }) => api<Provider[]>("/api/providers", { signal }),
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Provider | null | undefined>(
    undefined,
  );
  const [message, setMessage] = useState("");
  return (
    <div className="standard-page">
      <Heading
        eyebrow={"EXPLORE THE WEB"}
        title={"More sources. One workspace."}
        description={
          "Check a public video page or direct media link. Availability depends on the source, and some websites restrict downloads."
        }
      />
      <div className="toolbar">
        <div className="search-field">
          <Search size={17} />
          <input
            aria-label="Search video sources"
            placeholder={"Find a source…"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isAdmin && (
          <Button onClick={() => setEditing(null)}>
            <Plus size={16} />
            {"Add website"}
          </Button>
        )}
      </div>
      {message && <Notice>{message}</Notice>}
      {providers.isError && (
        <Notice kind="error">{errorMessage(providers.error)}</Notice>
      )}
      {isAdmin && editing !== undefined && (
        <Suspense fallback={<Busy />}>
          <ProviderEditor
            key={editing?.id ?? "new"}
            provider={editing}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              setMessage("Source saved.");
            }}
          />
        </Suspense>
      )}
      {providers.isPending ? (
        <Busy />
      ) : (
        <div className="provider-grid">
          {providers.data
            ?.filter((p) =>
              (p.name + p.domains.join())
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((provider) => (
              <article className="panel provider-card" key={provider.id}>
                <div className="provider-card-top">
                  <div className="source-logo">{provider.name[0]}</div>
                  <span
                    className={`badge ${provider.support_status === "available" ? "status-completed" : "subtle"}`}
                  >
                    {provider.enabled ? provider.support_status : "disabled"}
                  </span>
                </div>
                <h3>{provider.name}</h3>
                <p>{provider.domains.join(" · ")}</p>
                <div className="provider-card-bottom">
                  <span>
                    {provider.last_checked_at
                      ? new Date(provider.last_checked_at).toLocaleDateString(
                          "en-US",
                        )
                      : "Not tested yet"}
                  </span>
                  {isAdmin ? (
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => setEditing(provider)}
                    >
                      {"Manage"}
                      <Settings2 size={14} />
                    </Button>
                  ) : (
                    <Link
                      to="/"
                      aria-label={`Try a video from ${provider.name}`}
                    >
                      <ArrowUpRight size={17} />
                    </Link>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
      <div className="panel source-extra">
        <Globe2 size={30} />
        <div>
          <h3>{"Have another website in mind?"}</h3>
          <p>
            {
              "Try its public video URL on the home page. Single embedded videos and direct media links are checked too; support is not guaranteed for every website."
            }
          </p>
        </div>
        <Button asChild variant="secondary">
          <Link to="/">
            {"Try a link"}
            <ArrowRight size={16} />
          </Link>
        </Button>
      </div>
    </div>
  );
}
