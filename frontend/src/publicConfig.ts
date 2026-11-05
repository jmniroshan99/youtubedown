import { resolveSupabaseUrl } from "./apiConfig";
import deployment from "./publicDeployment.json";

// Shared by the client and OAuth validation. Correct only recorded deployment
// typos on the exact owned production hostname; other projects stay explicit.
export function getSupabaseUrl() {
  return resolveSupabaseUrl(
    import.meta.env.VITE_SUPABASE_URL || "",
    import.meta.env.DEV,
    window.location.hostname,
    deployment,
  );
}
