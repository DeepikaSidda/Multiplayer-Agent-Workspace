import { defineConfig } from "vite";

/**
 * Dev/build config for the Multiplayer Agent Workspace client.
 *
 * The compiled client library lives in `dist/` (built via `tsc`), whose files
 * are plain ESM `.js` with `.js` relative imports — so Vite/esbuild can serve
 * and bundle them directly, resolving bare specifiers (`react`, `yjs`,
 * `@maw/shared`) from node_modules. The browser entry (`main.tsx`) is the only
 * source file Vite transpiles.
 */
const SERVER_ORIGIN = process.env.DEV_SERVER_ORIGIN ?? "http://localhost:8787";

export default defineConfig({
  root: ".",
  build: {
    // Production browser bundle served by the Node server (single-origin deploy).
    outDir: "dist-web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    // In dev the client is on :5173 and the server on :8787; proxy API + WS so
    // the browser can use same-origin URLs in both dev and production.
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true },
      "/ws": { target: SERVER_ORIGIN.replace(/^http/, "ws"), ws: true },
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "yjs"],
  },
});
