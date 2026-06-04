// Verify flash decoration on eval and Cmd+. hush shortcut.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(new globalThis.URL(".", import.meta.url).pathname, "out");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(c => c.newPage());

await page.goto("http://localhost:7654/", { waitUntil: "load" });
await page.waitForSelector(".cm-editor");
await page.waitForTimeout(400);

// Manual sync so we don't wait for Link.
await page.locator("#sync").selectOption("manual");
await page.waitForTimeout(200);

// Clear & write.
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type('d1 $ s "bd ~ sd ~"');

// Eval block. Screenshot immediately, then 50ms, 200ms, 500ms to see fade.
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(30);
const flashClass = await page.evaluate(() => {
  const lines = document.querySelectorAll(".cm-content .cm-line");
  return [...lines].map((l) => l.className);
});
console.log("line classes immediately after eval:", JSON.stringify(flashClass));

await page.screenshot({ path: path.join(OUT, "flash-immediate.png"), clip: { x: 0, y: 100, width: 600, height: 200 } });
await page.waitForTimeout(2000);

// Verify orbit-monitor populated.
const monitorBefore = (await page.locator("#orbit-monitor").textContent())?.trim();
console.log("monitor before hush:", monitorBefore);

// Cmd+. → hush.
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+.");
await page.waitForTimeout(500);

const statusAfter = (await page.locator("#status-pill").textContent())?.trim();
const monitorAfter = (await page.locator("#orbit-monitor").textContent())?.trim();
console.log("status after Cmd+.:", statusAfter);
console.log("monitor after Cmd+.:", monitorAfter || "(empty)");

await page.screenshot({ path: path.join(OUT, "after-hush-cmd-period.png"), fullPage: true });

// Final test: Eval a bad pattern → expect error in log panel.
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type('d1 $ totallyMadeUpFunction');
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(400);

// Open log panel.
const logPanel = page.locator("#logToggle, [data-action=toggleLog], summary").first();
const hasLog = await logPanel.count();
let logContent = "";
if (hasLog > 0) {
  await logPanel.click().catch(() => {});
  await page.waitForTimeout(200);
}
logContent = (await page.locator("#logBody, [role=log]").textContent().catch(() => "")) || "";
console.log("log content sample:", logContent.slice(0, 300));

await browser.close();
