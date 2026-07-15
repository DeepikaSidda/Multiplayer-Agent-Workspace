import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Component tests (presence, message log/input, artifact editor) render
    // React into a DOM, so the client suite runs under jsdom. The transport
    // tests (task 13.1) use an injected fake socket + a headless Y.Doc and run
    // unchanged under jsdom as well.
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
