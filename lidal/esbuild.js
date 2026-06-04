// Lidal has up to three bundles:
//   1. dist/extension.js          — the Extension Host (Node VM sandbox) bundle.
//      Built via the shared build-extension.js helper, which adds the EH
//      polyfill banner and externalizes native deps.
//   2. dist/editor-client.js      — the browser-side CodeMirror 6 editor. Pure
//      ESM/browser code, bundled with esbuild directly (no banner, no native
//      externals).
//   3. dist/extension-headless.cjs — only built with `--headless`. Same source
//      tree as #1 but with easymidi + abletonlink aliased to no-op stubs so it
//      runs on a vanilla Node install (no ALSA / no Link prebuilds). Used by
//      the Playwright e2e harness in CI; not shipped to users.

const path = require("path");
const esbuild = require("esbuild");
const buildExtension = require("../scripts/build-extension");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const headlessOnly = process.argv.includes("--headless");

async function buildEditorClient() {
  const opts = {
    entryPoints: [path.join(__dirname, "src/editor/client.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    outfile: path.join(__dirname, "dist/editor-client.js"),
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    logLevel: "warning",
  };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    return ctx;
  }
  await esbuild.build(opts);
  return null;
}

// Headless variant: same entry as the production bundle but with the native
// deps inlined as stubs. We can't reuse build-extension.js because that helper
// hard-externalizes `arclightNativeDeps`. So we call esbuild directly and rely
// on an `alias` map to swap the native deps for the stubs in test/headless/.
async function buildHeadlessExtension() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "src/extension.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    outfile: path.join(__dirname, "dist/extension-headless.cjs"),
    define: { global: "globalThis" },
    alias: {
      easymidi: path.join(__dirname, "test/headless/easymidi-stub.cjs"),
      abletonlink: path.join(__dirname, "test/headless/abletonlink-stub.cjs"),
    },
    minify: false,
    sourcemap: true,
    sourcesContent: false,
    logLevel: "warning",
  });
}

async function main() {
  if (headlessOnly) {
    await buildHeadlessExtension();
    return;
  }
  await Promise.all([
    buildExtension({
      entryPoint: "src/extension.ts",
      outfile: "dist/extension.js",
      watch,
      production,
    }),
    buildEditorClient(),
  ]);
}

main().catch((e) => { console.error(e); process.exit(1); });
