import { defineConfig } from "vite-plus";

// The web configurator lives in web/ and builds to dist/ for GitHub Pages.
// generate.ts at the root is shared with the setup.ts wizard, which runs on
// plain Node with nothing installed — so nothing here may be needed by it.
export default defineConfig({
  root: "web",
  // Relative, so the same build works at /agent-env/ on Pages, on a fork, or
  // opened from any other path.
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  test: {
    root: ".",
    include: ["*.test.ts"],
  },
  // Only the TypeScript toolchain is formatted here. The docs, workflows and
  // the image's own files keep the hand layout they were written in.
  fmt: {
    ignorePatterns: ["**/*.md", "**/*.yml", "**/*.yaml", "rootfs/**", "dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
