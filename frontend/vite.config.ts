import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { localProxyTarget } from "./src/apiConfig.ts";
export default defineConfig(({ mode }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL(".", import.meta.url)),
    "VITE_",
  );
  const target = localProxyTarget(env.VITE_API_BASE_URL || "");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      allowedHosts: ["terminal.local"],
      port: 5173,
      strictPort: true,
      proxy: target
        ? {
            "^/backend(?:/|$)": {
              target,
              // Keep the original Origin and Authorization headers. No production proxy is built.
              rewrite: (path) => path.replace(/^\/backend/, ""),
              configure: (proxy) => {
                proxy.on("error", (_error, _request, response) => {
                  if ("writeHead" in response && !response.headersSent) {
                    response.writeHead(503, {
                      "Content-Type": "application/json",
                      "Cache-Control": "no-store",
                    });
                    response.end(
                      JSON.stringify({
                        status: "backend_unreachable",
                        error: {
                          code: "BACKEND_UNREACHABLE",
                          message:
                            "The local backend is not responding. Start Docker Desktop and run start.bat. Run diagnose.bat if it still fails.",
                        },
                      }),
                    );
                  }
                });
              },
            },
          }
        : undefined,
    },
    build: {
      sourcemap: false,
      manifest: true,
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: "supabase", test: /node_modules[\\/]@supabase[\\/]/ },
            ],
          },
        },
      },
    },
  };
});
