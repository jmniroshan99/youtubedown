export function serviceMessage(status: string, local: boolean) {
  const messages: Record<string, string> = {
    checking: "Checking the download service…",
    ready: "The download service is ready.",
    not_configured: local
      ? "Backend setup is incomplete. Check VITE_API_BASE_URL and the server-only SUPABASE_SECRET_KEY, then run start.bat. Never put the server key in a VITE variable."
      : "The download service has not been configured. Please contact the site owner.",
    gateway_unavailable: "The local gateway is running but cannot reach the API. Run diagnose.bat to check the API container.",
    redis_unavailable:
      "The download queue is offline. The server needs its Redis service running.",
    database_unavailable:
      "The server cannot reach its database. Check the Supabase project and the backend egress connection.",
    database_auth_failed:
      "Supabase rejected the server's database access. Check the server secret key and database permissions.",
    database_schema_missing:
      "The youtubedown database tables are missing. Complete the first-time database setup in START_HERE.md.",
    worker_unavailable:
      "The processing worker is offline or still starting. Start the worker and check the connection again.",
    invalid_response:
      "The configured API address did not return a valid health response. Check that it points to the backend, not the frontend website.",
    backend_unreachable: local
      ? "The local backend is not responding. Open Docker Desktop, then run start.bat. If it still fails, run diagnose.bat."
      : "The download backend is not responding. Please try again shortly.",
    unreachable: local
      ? "Cannot connect to the backend. Run diagnose.bat to check the API address, Docker services and CORS settings."
      : "Cannot connect to the download service. The server may be offline or its HTTPS/CORS configuration may need attention.",
  };
  return (
    messages[status] ??
    "The download service is unavailable. Check the connection again shortly."
  );
}
