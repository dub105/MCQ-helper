import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Repo name is used as the base path for GitHub Pages project sites
// (https://<user>.github.io/MCQ-helper/).
export default defineConfig({
  plugins: [react()],
  base: "/MCQ-helper/",
});
