// Tour of every major UX surface — produces a screenshot battery for review.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(new globalThis.URL(".", import.meta.url).pathname, "tour");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(c => c.newPage());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.addInitScript(() => {
  try {
    localStorage.removeItem("lidal.welcome.dismissed.v1");
    localStorage.removeItem("lidal.cheatsheet.expanded.v1");
  } catch {}
});

await page.goto("http://localhost:7654/", { waitUntil: "load" });
await page.waitForSelector(".cm-editor");
await page.waitForTimeout(500);

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log("  📸", `${name}.png`);
};

const clearAndType = async (text) => {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
};

// 1. Fresh load, banner showing.
console.log("\n1. fresh load with welcome banner");
await shot("01-fresh-load");

// 2. Banner dismissed.
console.log("\n2. banner dismissed");
await page.locator("[data-action=dismiss]").click();
await page.waitForTimeout(150);
await shot("02-banner-dismissed");

// 3. Multi-orbit pattern, running.
console.log("\n3. multi-orbit running");
await page.locator("#sync").selectOption("manual");
await page.waitForTimeout(200);
await clearAndType(`d1 $ s "bd ~ sd ~"\n\nd2 $ n "c4 e4 g4" # gain 0.7\n\nd3 $ s "hh*8" # gain 0.5\n\nd4 $ s "rim ~ ~ rim"\n\nc1 $ ctrl 74 sine`);
await page.keyboard.press("Meta+Shift+Enter");
await page.waitForTimeout(1500);
await shot("03-multi-orbit-running");

// 4. Editor in focus with cursor near a combinator (autocomplete trigger).
console.log("\n4. autocomplete popup");
await clearAndType("d1 $ s \"bd\" # eve");
await page.waitForTimeout(400);
await shot("04-autocomplete-popup");
// Don't dismiss yet — capture with the popup open.

// 5. After accepting 'every' snippet.
console.log("\n5. snippet placeholder mode");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await shot("05-snippet-placeholder");

// 6. Hover tooltip on a combinator.
console.log("\n6. hover tooltip");
await page.locator(".cm-editor").click();
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await clearAndType(`d1 $ every 4 rev (s "bd ~ sd ~")`);
const box = await page.evaluate(() => {
  for (const s of document.querySelectorAll(".cm-content span")) {
    if (s.textContent === "every") {
      const r = s.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
});
if (box) {
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(700);
}
await shot("06-hover-tooltip");

// 7. Help overlay (Cmd+?).
console.log("\n7. help overlay");
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+Shift+/");
await page.waitForTimeout(400);
await shot("07-help-overlay");

// 8. Help overlay with search filter.
console.log("\n8. help overlay filtered");
await page.locator("#help-search").fill("every");
await page.waitForTimeout(200);
await shot("08-help-overlay-filtered");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 9. Command palette (Cmd+P).
console.log("\n9. command palette");
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+p");
await page.waitForTimeout(400);
await shot("09-command-palette");

// 10. Command palette filtered.
console.log("\n10. command palette filtered");
await page.locator("#palette-search, #palette-overlay input").first().fill("sync");
await page.waitForTimeout(200);
await shot("10-command-palette-filtered");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 11. Diagnostic error state.
console.log("\n11. diagnostic error");
// Move mouse away first so the hover tooltip from step 6 doesn't intercept clicks.
await page.mouse.move(0, 0);
await page.waitForTimeout(200);
await clearAndType("d1 $ totallyMadeUpFunction");
await page.keyboard.press("Meta+Shift+Enter");
await page.waitForTimeout(800);
await shot("11-diagnostic-error");

// 12. Hovering the error to see the diagnostic tooltip.
console.log("\n12. diagnostic tooltip");
const errBox = await page.evaluate(() => {
  for (const s of document.querySelectorAll(".cm-content span")) {
    if (s.textContent.includes("totallyMadeUpFunction")) {
      const r = s.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
});
if (errBox) {
  await page.mouse.move(errBox.x, errBox.y);
  await page.waitForTimeout(700);
}
await shot("12-diagnostic-tooltip");

// 13. Cheat sheet expanded.
console.log("\n13. cheat sheet expanded");
await page.locator("#cheatsheetStrip").click();
await page.waitForTimeout(200);
await shot("13-cheatsheet-expanded");

// 14. Logs panel expanded.
console.log("\n14. logs panel expanded");
await page.locator("#logToggle, summary").first().click().catch(() => {});
await page.waitForTimeout(200);
await shot("14-logs-expanded");

console.log(`\nAll screenshots written to ${OUT}`);
await browser.close();
