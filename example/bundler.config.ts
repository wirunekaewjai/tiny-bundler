import { defineConfig } from "@wirunekaewjai/tiny-bundler";

export default defineConfig({
  assetsDir: "assets",
  backendDir: "backend",
  backendLanguage: undefined, // no backend
  bundleDir: ".bundle",
  frontendAlias: "@", // same as alias in tsconfig.json
  frontendDir: "frontend",
  tempDir: "temp",
  templateDir: "templates",
});
