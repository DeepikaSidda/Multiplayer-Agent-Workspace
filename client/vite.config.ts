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
export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    strictPort: false,
  },
  esbuild: {
    jsx: "automatic",
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "yjs"],
  },
});
