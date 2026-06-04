#!/usr/bin/env node
// Lidal deploy: invoke the shared helper, then drop the editor-client.js bundle
// into <dest>/dist alongside extension.js. The shared deploy helper only knows
// about a single entry point; lidal ships two bundles.

const fs = require("fs");
const os = require("os");
const path = require("path");

require("../../scripts/deploy-extension.js")(__dirname);

const ROOT = path.resolve(__dirname, "..");
const slug = path.basename(ROOT);
const dest = path.join(os.homedir(), "Music", "Ableton Alpha", "User Library", "Extensions", slug);
const destDist = path.join(dest, "dist");

const srcClient = path.join(ROOT, "dist", "editor-client.js");
if (!fs.existsSync(srcClient)) {
  console.warn(`  [warn] dist/editor-client.js not found — editor will 404 on /editor-client.js`);
} else {
  fs.copyFileSync(srcClient, path.join(destDist, "editor-client.js"));
  const sizeKb = Math.round(fs.statSync(srcClient).size / 1024);
  console.log(`✓ Copied editor-client.js (${sizeKb} KB) → ${destDist}/editor-client.js`);
}
