// Ad-hoc Playwright probe for the Lidal editor.
// Usage: node test/e2e/probe.mjs [url]
// Defaults to http://localhost:7654/

import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const TARGET_URL = process.argv[2] || "http://localhost:7654/";
const OUT_DIR = path.resolve(new globalThis.URL(".", import.meta.url).pathname, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const consoleEvents = [];
const pageErrors = [];
page.on("console", (msg) => consoleEvents.push({ type: msg.type(), text: msg.text() }));
page.on("pageerror", (err) => pageErrors.push({ message: err.message, stack: err.stack }));

const response = await page.goto(TARGET_URL, { waitUntil: "load", timeout: 10_000 });
console.log(`GET ${TARGET_URL} → ${response?.status()}`);

// SSE keeps connection open, so "networkidle" never fires. Wait for CM bootstrap explicitly.
await page.waitForSelector(".cm-editor", { timeout: 5_000 }).catch(() => {});
await page.waitForTimeout(500);

const probe = await page.evaluate(() => {
  const cmHost = document.querySelector(".cm-editor");
  const cmContent = document.querySelector(".cm-content");
  const statusPill = document.querySelector('[role="status"], #status, .status-pill');
  const monitor = document.querySelector("#orbit-monitor");
  const banner = document.querySelector("#banner");
  const logPanel = document.querySelector('[role="log"], #log, .log-panel');
  const editorClientScript = [...document.scripts].find((s) =>
    (s.src || "").includes("editor-client.js")
  );

  // Sample some computed colors so we can sanity check the theme.
  const sample = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, backgroundColor: cs.backgroundColor, fontFamily: cs.fontFamily };
  };

  return {
    title: document.title,
    bodyText: document.body.innerText.slice(0, 400),
    cmPresent: !!cmHost,
    cmContentText: cmContent ? cmContent.innerText.slice(0, 400) : null,
    statusPillText: statusPill ? statusPill.textContent.trim() : null,
    monitorPresent: !!monitor,
    bannerPresent: !!banner,
    bannerText: banner ? banner.textContent.trim().slice(0, 200) : null,
    logPanelPresent: !!logPanel,
    editorClientLoaded: !!editorClientScript,
    sampleEditor: sample(".cm-editor"),
    sampleBody: sample("body"),
  };
});

await page.screenshot({ path: path.join(OUT_DIR, "01-initial.png"), fullPage: true });

console.log("\n--- DOM probe ---");
console.log(JSON.stringify(probe, null, 2));

console.log("\n--- console events ---");
for (const e of consoleEvents) console.log(`  [${e.type}] ${e.text}`);

console.log("\n--- page errors ---");
for (const e of pageErrors) console.log(`  ${e.message}\n${(e.stack || "").split("\n").slice(0, 3).join("\n")}`);

// Try typing something and see if highlighting kicks in.
if (probe.cmPresent) {
  await page.locator(".cm-content").click();
  await page.keyboard.type('\nd1 $ s "bd ~ sd ~"');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, "02-after-type.png"), fullPage: true });

  // Count highlighted tokens to confirm the Lidal highlighter actually painted something.
  const tokenCounts = await page.evaluate(() => {
    const all = document.querySelectorAll(".cm-content span[class*='tok-']");
    const counts = {};
    for (const s of all) {
      for (const c of s.classList) {
        if (c.startsWith("tok-")) counts[c] = (counts[c] || 0) + 1;
      }
    }
    return { totalSpans: all.length, counts };
  });
  console.log("\n--- highlighter token counts after typing ---");
  console.log(JSON.stringify(tokenCounts, null, 2));
}

console.log(`\nScreenshots in ${OUT_DIR}`);
await browser.close();
