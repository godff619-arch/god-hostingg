import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.PORT || 3600);

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port,
      strictPort: true,
      host: "127.0.0.1",
      // Dev-only: allow the panel to be reached through a public tunnel /
      // sandbox host (Cloudflare quick tunnel, CodeSandbox). Vite 5+ otherwise
      // returns 403 "Blocked request" for any Host header it doesn't recognise.
      // Extra hosts can be added via VITE_ALLOWED_HOSTS=a.com,b.com (comma-sep).
      allowedHosts: [
        ".trycloudflare.com",
        ".csb.app",
        ".ngrok-free.app",
        ".ngrok.io",
        ...(env.VITE_ALLOWED_HOSTS
          ? env.VITE_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
          : []),
      ],
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8000",
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq, req) => {
              // Keep cookie + GitHub setup_url on the Vite origin (not :8000)
              if (req.headers.host) {
                proxyReq.setHeader("X-Forwarded-Host", req.headers.host);
              }
              proxyReq.setHeader("X-Forwarded-Proto", "http");
            });
          },
        },
        "/ws": {
          target: "ws://127.0.0.1:8000",
          ws: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
