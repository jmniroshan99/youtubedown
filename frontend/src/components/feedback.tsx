import { Check, CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { ProcessingMark } from "./ProcessingMark";
export function Busy() {
  return (
    <div className="busy" role="status" aria-live="polite">
      <ProcessingMark />
      <span>Loading…</span>
    </div>
  );
}
export function Notice({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "info" | "error" | "success";
}) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`notice ${kind}`}
    >
      {kind === "success" ? <Check size={18} /> : <CircleHelp size={18} />}
      <span>{children}</span>
    </div>
  );
}

export function Heading({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description: string;
  eyebrow: string;
}) {
  return (
    <div className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
