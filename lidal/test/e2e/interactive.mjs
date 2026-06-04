// Interactive feature probe — autocomplete, comment toggle, banner dismissal,
// bracket close, eval cycle, orbit monitor.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(new globalThis.URL(".", import.meta.url).pathname, "out");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(`[console.error] ${m.text()}`); });

// Clear banner-dismissal so we can test it.
await page.addInitScript(() => { try { localStorage.removeItem("lidal.welcome.dismissed.v1"); } catch {} });

await page.goto("http://localhost:7654/", { waitUntil: "load" });
await page.waitForSelector(".cm-editor");
await page.waitForTimeout(400);

const ok = (label, v) => console.log(`  ${v ? "✅" : "❌"} ${label}${v === true ? "" : "  →  " + JSON.stringify(v)}`);

// 1. Banner visible?
{
  const visible = await page.locator("#banner.visible").count();
  ok("banner shows on first load", visible === 1);
}

// 2. Click "Got it" → banner dismisses, localStorage set.
{
  await page.locator("[data-action=dismiss]").click();
  await page.waitForTimeout(150);
  const hidden = (await page.locator("#banner.visible").count()) === 0;
  const ls = await page.evaluate(() => localStorage.getItem("lidal.welcome.dismissed.v1"));
  ok("banner dismisses on click", hidden);
  ok("banner dismissal persisted to localStorage", ls === "1");
}

// 3. Bracket auto-close: type `[` → expect `]` to be inserted.
async function clearAndType(text) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

{
  await clearAndType("[");
  const content = await page.locator(".cm-content").innerText();
  ok("typing '[' auto-closes to '[]'", content === "[]");
}

{
  await clearAndType('"');
  const content = await page.locator(".cm-content").innerText();
  ok('typing \'"\' auto-closes to \'""\'', content === '""');
}

// 4. Comment toggle: Cmd+/ on a line should toggle `-- `.
{
  await clearAndType("hush");
  await page.keyboard.press("Meta+/");
  await page.waitForTimeout(100);
  const c1 = await page.locator(".cm-content").innerText();
  await page.keyboard.press("Meta+/");
  await page.waitForTimeout(100);
  const c2 = await page.locator(".cm-content").innerText();
  ok("Cmd+/ adds '-- ' comment marker", c1.startsWith("-- ") && c1.includes("hush"));
  ok("Cmd+/ again removes comment marker", c2 === "hush");
}

// 5. Autocomplete: type 'fa' and wait for completion popup.
{
  await clearAndType("fa");
  await page.waitForTimeout(300);
  const popupVisible = await page.locator(".cm-tooltip-autocomplete").count();
  let firstOption = null;
  if (popupVisible > 0) {
    firstOption = await page.locator(".cm-tooltip-autocomplete li").first().innerText().catch(() => null);
  }
  ok("autocomplete popup appears for 'fa'", popupVisible > 0);
  ok(`first completion is 'fast' (got ${JSON.stringify(firstOption)})`, (firstOption || "").includes("fast"));
}

// 6. Press Escape and clear; verify keyboard shortcut hint area shows ⌘↵ etc.
{
  await page.keyboard.press("Escape");
  const shortcutsText = await page.locator("body").innerText();
  ok("editor mentions ⌘↵ in chrome (shortcut legend present)", /⌘↵|⌘↩|⌘ Enter/i.test(shortcutsText));
}

// 7. Eval a real pattern → expect status pill to change and orbit-monitor to populate.
{
  await clearAndType('d1 $ s "bd ~ sd ~"');
  await page.keyboard.press("Meta+Shift+Enter");
  await page.waitForTimeout(600);
  const status = await page.locator("#status-pill").textContent().catch(() => "");
  ok(`status pill updated after eval (got '${status?.trim()}')`, /running|playing|↻|▶/i.test(status || "") || (status || "").includes("d1"));
  const monitorText = await page.locator("#orbit-monitor").textContent().catch(() => "");
  ok(`orbit-monitor shows d1 after eval (got '${monitorText?.trim()}')`, (monitorText || "").includes("d1"));
}

await page.screenshot({ path: path.join(OUT, "interactive-final.png"), fullPage: true });

console.log("\n--- page errors ---");
for (const e of errors) console.log("  " + e);
if (errors.length === 0) console.log("  (none)");

await browser.close();
