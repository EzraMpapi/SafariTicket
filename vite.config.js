import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Workspace source, so a domain change is picked up without a rebuild.
      "@safaritiketi/domain": resolve(__dirname, "../../packages/domain/src/index.js"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,   // do not ship a map that re-expands the bundle
    rollupOptions: {
      output: {
        manualChunks: {
          // The QR encoder and crypto primitives are sizeable and rarely change.
          domain: ["@safaritiketi/domain"],
          vendor: ["react", "react-dom", "@supabase/supabase-js"],
        },
      },
    },
  },
  server: { port: 5173 },
});
