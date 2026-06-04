// Headless host for the Lidal extension. Starts the same activate() that Live
// would call, but with the SDK TestHarness standing in for the real Extension
// Host. Used by the Playwright e2e suite — Live, ALSA, and Ableton Link are
// not in the picture.
//
// The extension bundle at dist/extension-headless.cjs has easymidi and
// abletonlink aliased to in-tree no-op stubs (see test/headless/*-stub.cjs),
// so this script runs on a vanilla Node install with no native deps. The HTTP
// server comes up on the same port (7654) as the production extension.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TestHarness } from "@ableton-extensions/sdk/testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const HEADLESS_BUNDLE = join(__dirname, "..", "..", "dist", "extension-headless.cjs");
if (!existsSync(HEADLESS_BUNDLE)) {
  console.error(`[lidal:headless] missing bundle: ${HEADLESS_BUNDLE}`);
  console.error("[lidal:headless] run `npm run build:headless` first.");
  process.exit(2);
}

// TestHarness ships a MockActivationContext whose `environment` only has
// `userId`. Lidal looks for `environment.storageDirectory`; if it's missing we
// degrade to "no persistence", which is fine for e2e but means the in-memory
// buffer resets between runs. Spin a tempdir so the persistence path is
// exercised end-to-end (catches regressions in the buffer-restore code).
const harness = new TestHarness({
  liveSet: { tempo: 120, isPlaying: false },
});
const storageDirectory = mkdtempSync(join(tmpdir(), "lidal-e2e-"));
const ctx = harness.activationContext;

// SDK 0.0.5-beta's TestHarness hardcodes `apiVersion === "0.0.4"` in its
// initializeExtensionHost mock. Lidal targets 0.0.5, so we re-bind the call
// to drop the version guard. The underlying `api` (commands, ui, environment,
// dataModel) is identical between the two versions for the surface lidal
// uses, so this is a safe local override.
const originalInit = ctx.initializeExtensionHost.bind(ctx);
ctx.initializeExtensionHost = () => originalInit({ apiVersion: "0.0.4" });
ctx.hostApiVersion = "0.0.5";
ctx.environment = { ...ctx.environment, storageDirectory };

const ext = require(HEADLESS_BUNDLE);
if (typeof ext.activate !== "function") {
  console.error("[lidal:headless] bundle does not export activate()");
  process.exit(3);
}

await ext.activate(ctx);
const port = process.env.LIDAL_HTTP_PORT || "7654";
console.log(`[lidal:headless] activate() returned · storage=${storageDirectory}`);
console.log(`[lidal:headless] editor at http://localhost:${port}/`);
console.log("[lidal:headless] press Ctrl+C to stop");

// Keep the event loop alive — the HTTP server registers handles, but be
// explicit so SIGINT/SIGTERM exit cleanly.
const heartbeat = setInterval(() => {}, 1 << 30);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    console.log(`\n[lidal:headless] ${sig} received — exiting`);
    process.exit(0);
  });
}
