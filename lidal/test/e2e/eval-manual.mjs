// Switch to manual sync and verify orbit-monitor + status pill actually update.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(new globalThis.URL(".", import.meta.url).pathname, "out");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(c => c.newPage());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("http://localhost:7654/", { waitUntil: "load" });
await page.waitForSelector(".cm-editor");
await page.waitForTimeout(400);

// Switch sync to Manual.
await page.locator("#sync").selectOption("manual");
await page.waitForTimeout(300);

// Clear buffer and write a simple pattern.
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type('d1 $ s "bd ~ sd ~"');
await page.keyboard.press("Meta+Shift+Enter");

// Wait for the scheduler to run a couple cycles.
await page.waitForTimeout(2000);

const status = (await page.locator("#status-pill").textContent())?.trim() || "";
const monitor = (await page.locator("#orbit-monitor").textContent())?.trim() || "";
const monitorPills = await page.locator("#orbit-monitor [data-orbit]").count().catch(() => 0);
console.log(`status pill: ${JSON.stringify(status)}`);
console.log(`monitor text: ${JSON.stringify(monitor)}`);
console.log(`monitor pills: ${monitorPills}`);

await page.screenshot({ path: path.join(OUT, "eval-manual.png"), fullPage: true });

// Hush and check status returns to stopped.
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("hush");
await page.keyboard.press("Meta+Shift+Enter");
await page.waitForTimeout(800);
const stoppedStatus = (await page.locator("#status-pill").textContent())?.trim() || "";
console.log(`after hush: ${JSON.stringify(stoppedStatus)}`);

await page.screenshot({ path: path.join(OUT, "after-hush.png"), fullPage: true });

await browser.close();
