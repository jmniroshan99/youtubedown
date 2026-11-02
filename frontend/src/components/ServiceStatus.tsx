import { useServiceHealth } from "../queries";
import { isLoopback } from "../apiConfig";
import { serviceMessage } from "../serviceHealth";
import { Button } from "./ui/button";

export function ServiceConnection() {
  const health = useServiceHealth();
  const status = health.isPending
    ? "checking"
    : health.isError
      ? "unreachable"
      : health.data.status;
  if (status === "ready") return null;
  return (
    <div className="offline-hint service-connection" aria-live="polite">
      <div>
        <strong>
          {status === "checking"
            ? "Checking service"
            : "Download service unavailable"}
        </strong>
        <p>{serviceMessage(status, isLoopback(window.location.hostname))}</p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="small"
        disabled={health.isFetching}
        onClick={() => void health.refetch()}
      >
        {health.isFetching ? "Checking…" : "Check connection"}
      </Button>
    </div>
  );
}
export function ServiceStatus() {
  const health = useServiceHealth();
  const ready = !health.isError && health.data?.status === "ready";
  return (
    <button
      className={`service-status ${ready ? "online" : ""}`}
      onClick={() => void health.refetch()}
      disabled={health.isFetching}
      title={serviceMessage(
        health.isError ? "unreachable" : (health.data?.status ?? "checking"),
        isLoopback(window.location.hostname),
      )}
      aria-live="polite"
    >
      <span className="tiny-dot" />
      {health.isPending
        ? "Checking service…"
        : ready
          ? "Service online"
          : "Service unavailable"}
    </button>
  );
}
