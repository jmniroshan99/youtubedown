import { createClient } from "@supabase/supabase-js";
import { isLoopback, resolveApiBase } from "./apiConfig";
import { clsx, type ClassValue } from "clsx";
import type { DatabaseSchema } from "./database.types";
import { privateRequestSignal } from "./requestScope";
import publicDeployment from "./publicDeployment.json";
export const cn = (...values: ClassValue[]) => clsx(values);
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const configurationError =
  !url || !key ? "Supabase configuration is missing." : "";
export const supabase =
  url && key
    ? createClient<DatabaseSchema>(url, key, {
        auth: {
          flowType: "pkce",
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      })
    : null;
export const apiBase = resolveApiBase(
  import.meta.env.VITE_API_BASE_URL || "",
  import.meta.env.DEV,
  window.location.hostname,
  publicDeployment,
);
export function checkApiBase(
  base: string,
  page: Location | URL = window.location,
): string {
  if (!base) return "The download service has not been connected yet.";
  if (base === "/backend" && import.meta.env.DEV && isLoopback(page.hostname))
    return "";
  try {
    const parsed = new URL(base);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return "The download service address is invalid. Please contact support.";
    if (
      (page.protocol === "https:" && parsed.protocol !== "https:") ||
      (!isLoopback(page.hostname) && isLoopback(parsed.hostname))
    )
      return "The download service address is not configured for this site. Please contact support.";
    return "";
  } catch {
    return "The download service address is invalid. Please contact support.";
  }
}
export class ApiError extends Error {
  constructor(
    message: string,
    public code = "REQUEST_FAILED",
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const configError = checkApiBase(apiBase);
  if (configError) throw new ApiError(configError, "NOT_CONFIGURED");
  const signal = AbortSignal.any([
    privateRequestSignal(),
    AbortSignal.timeout(20_000),
    ...(init.signal ? [init.signal] : []),
  ]);
  signal.throwIfAborted();
  const session = (await supabase?.auth.getSession())?.data.session;
  signal.throwIfAborted();
  if (!session)
    throw new ApiError(
      "Your session is unavailable. Continue as a guest or sign in again.",
      "UNAUTHORIZED",
    );
  const response = await fetch(apiBase + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...init.headers,
    },
    signal,
    cache: "no-store",
  }).catch((error: unknown) => {
    if (signal.aborted) throw signal.reason;
    if (error instanceof TypeError)
      throw new ApiError(
        isLoopback(window.location.hostname)
          ? "Cannot reach the download backend. Run start.bat with Docker Desktop running, or run diagnose.bat to identify the problem."
          : "Cannot reach the download service. Use Check connection below; the server may be offline or its HTTPS/CORS configuration may need attention.",
        "SERVICE_UNAVAILABLE",
      );
    throw error;
  });
  const data = await response.json().catch(() => {
    if (response.ok)
      throw new ApiError(
        "The download service returned an invalid response. Please try again.",
        "INVALID_RESPONSE",
      );
    return {};
  });
  if (!response.ok)
    throw new ApiError(
      data.error?.message ||
        "The request could not be completed. Please try again.",
      data.error?.code,
      Number(response.headers.get("Retry-After")) || undefined,
    );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(
      "The download service returned an unexpected response. Please contact support.",
      "INVALID_RESPONSE",
    );
  return data as T;
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.retryAfterSeconds)
    return `${error.message} Try again in about ${Math.max(1, Math.ceil(error.retryAfterSeconds / 60))} minute(s).`;
  if (error instanceof Error && error.name === "TimeoutError")
    return "The download service took too long to respond. Please try again shortly.";
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export function bytes(value?: number | null) {
  if (!value) return "—";
  const unit = value > 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
  return `${(value / unit).toFixed(1)} ${unit === 1024 ** 3 ? "GB" : "MB"}`;
}
export function duration(value?: number | null) {
  return value
    ? `${Math.floor(value / 60)}:${Math.floor(value % 60)
        .toString()
        .padStart(2, "0")}`
    : "—";
}
export type Format = {
  id: string;
  label: string;
  kind: "audio" | "video";
  ext: string;
  height?: number;
  size?: number;
  estimated_size?: number;
  merging?: boolean;
  has_audio?: boolean | null;
};
export type Analysis = {
  analysis_id: string;
  status: string;
  error_code?: string;
  error_stage?: string;
  extractor_version?: string;
  title: string;
  duration?: number;
  platform: string;
  thumbnail?: string;
  formats: Format[];
  download_limits?: { max_bytes: number; max_duration: number };
};
export type Job = {
  id: string;
  title: string;
  source_url: string;
  platform: string;
  selected_format: string;
  status: string;
  progress: number | null;
  speed?: number;
  eta?: number;
  file_size?: number;
  error_code?: string;
  error_stage?: string;
  created_at: string;
  expires_at?: string;
};
export type Provider = {
  id: string;
  name: string;
  domains: string[];
  adapter_key: string;
  enabled: boolean;
  support_status: string;
  last_checked_at: string | null;
};
