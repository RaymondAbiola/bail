import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative asset paths and hash routes, so the built site works from any static host or folder.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2022", sourcemap: false },
});
