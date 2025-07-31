import { defineConfig } from "@wirunekaewjai/tiny-bundler";

export default defineConfig({
  backend: undefined, // no backend

  bundle: {
    assets: "assets",
    outDir: ".bundle",
  },

  frontend: {
    alias: "@",
    srcDir: "frontend",
    templates: "templates",
  },
});
