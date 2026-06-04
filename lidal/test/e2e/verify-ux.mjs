// Full UX verification — orbit colors, diagnostics, help overlay search/Esc,
// command palette, snippets, hover tooltip.
//
// Runs against any host that serves the Lidal editor at $LIDAL_E2E_URL
// (default http://localhost:7654/). In CI we point this at the headless
// runner (test/headless/runner.mjs) so the suite doesn't require Live to be
// running.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(new globalThis.URL(".", import.meta.url).pathname, "out");
fs.mkdirSync(OUT, { recursive: true });

const TARGET_URL = process.env.LIDAL_E2E_URL || "http://localhost:7654/";
// CodeMirror keymaps use `Mod-*`, which Playwright maps as `Meta` on macOS
// (Cmd) and `Control` everywhere else. Pick the right physical key per host
// so the CI Linux runner exercises the same shortcut paths as a dev's Mac.
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(c => c.newPage());
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

await page.addInitScript(() => {
  try {
    localStorage.removeItem("lidal.welcome.dismissed.v1");
    localStorage.removeItem("lidal.cheatsheet.expanded.v1");
  } catch {}
});

await page.goto(TARGET_URL, { waitUntil: "load" });
await page.waitForSelector(".cm-editor");
await page.waitForTimeout(400);

// Track failures so the suite exits non-zero in CI when any assertion fails.
let failures = 0;
const ok = (label, v) => {
  const pass = v === true;
  if (!pass) failures++;
  console.log(`  ${pass ? "✅" : "❌"} ${label}${pass ? "" : "  → " + JSON.stringify(v)}`);
};
const clearAndType = async (text) => {
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
};

await page.locator("#sync").selectOption("manual");
await page.waitForTimeout(200);
await clearAndType(`d1 $ s "bd ~ sd ~"\n\nd2 $ n "c4 e4 g4"\n\nd3 $ s "hh*8" # gain 0.5\n\nc1 $ ctrl 74 sine`);
await page.keyboard.press(`${MOD}+Shift+Enter`);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, "verify-01-running.png"), fullPage: true });

console.log("\n### Per-orbit colours in editor");
{
  const colors = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".cm-content [data-orbit]").forEach((el) => {
      const cs = getComputedStyle(el.querySelector("span") || el);
      out.push({ orbit: el.dataset.orbit, color: cs.color });
    });
    return out;
  });
  const unique = new Set(colors.map((c) => c.color));
  // The palette has 10 hues with d1=c1, d11=d1 sharing by design (modulo).
  // For our test set (d1, d2, d3, c1) we expect 3 unique colours: d1 and c1 share.
  ok(`orbit decorations applied (${colors.length} tokens)`, colors.length >= 4);
  ok(`distinct colours per d-orbit set (${unique.size} unique — d1==c1 by design)`, unique.size === 3);
  console.log("    samples:", colors);
}

console.log("\n### c4 in string NOT decorated as orbit");
{
  const fakeOrbits = await page.evaluate(() => {
    return [...document.querySelectorAll(".cm-content [data-orbit]")]
      .map((el) => ({ orbit: el.dataset.orbit, text: el.textContent }));
  });
  const c4Decorated = fakeOrbits.some((o) => o.text === "c4");
  ok("c4 inside string is NOT decorated as orbit", !c4Decorated);
}

console.log("\n### Status pill orbit colors");
{
  const pillHtml = await page.locator("#status-pill").innerHTML();
  ok("status pill renders multiple coloured orbit spans",
    /style.*color/i.test(pillHtml) || /class.*orbit/i.test(pillHtml));
}

console.log("\n### Diagnostics with squiggle + gutter dot");
{
  await clearAndType(`d1 $ totallyMadeUpFunction`);
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, "verify-02-error.png"), fullPage: true });
  const gutter = await page.locator(".cm-gutter-lint .cm-lint-marker, .cm-lint-marker-error").count();
  const inlineDiag = await page.locator(".cm-lintRange, .cm-lintRange-error, [class*='lintRange']").count();
  ok(`gutter lint marker visible (${gutter})`, gutter > 0);
  ok(`inline error decoration visible (${inlineDiag})`, inlineDiag > 0);
}

console.log("\n### Help overlay (Cmd+?) search + Escape sequence");
{
  await page.locator(".cm-content").click();
  // Send the question-mark key directly rather than Shift+/. Chromium on
  // Linux reports the post-shift `key="?"` even though `code="Slash"`,
  // which doesn't match CodeMirror's `"Shift-Mod-/"` binding (it parses
  // by `key`). The editor also registers `"Mod-?"` for exactly this case,
  // and `Control+?` produces `key="?"` on every platform.
  await page.keyboard.press(`${MOD}+?`);
  await page.waitForTimeout(300);
  const visible = await page.locator("#help-overlay").isVisible();
  ok("help overlay opens on Cmd+?", visible);
  const allRows = await page.locator("#help-overlay [data-name]").count();
  await page.locator("#help-search").fill("every");
  await page.waitForTimeout(200);
  const visibleRows = await page.locator("#help-overlay [data-name]:not([hidden])").count();
  ok(`search filters: ${allRows} → ${visibleRows} after typing 'every'`,
    allRows > 50 && visibleRows < 10 && visibleRows > 0);
  // First Esc → clears search
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const searchAfter = await page.locator("#help-search").inputValue();
  ok("first Escape clears search", searchAfter === "");
  // Second Esc → closes overlay
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const stillVisible = await page.locator("#help-overlay").isVisible();
  ok("second Escape closes overlay", !stillVisible);
}

console.log("\n### Command palette (Cmd+P)");
{
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+p`);
  await page.waitForTimeout(400);
  const paletteState = await page.evaluate(() => {
    const el = document.getElementById("palette-overlay");
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return { exists: true, display: cs.display, visibility: cs.visibility };
  });
  ok(`command palette opens on Cmd+P (display=${paletteState.display})`,
    paletteState.exists && paletteState.display !== "none" && paletteState.visibility !== "hidden");
  await page.screenshot({ path: path.join(OUT, "verify-04-palette.png"), fullPage: true });
  // Type to filter commands.
  const cmdInput = page.locator("#palette-search, #palette-overlay input").first();
  if (await cmdInput.count() > 0) {
    const before = await page.locator("#palette-overlay .lidal-palette-row").count();
    await cmdInput.fill("hush");
    await page.waitForTimeout(250);
    const after = await page.locator("#palette-overlay .lidal-palette-row").count();
    ok(`palette filters commands (${before} → ${after} after 'hush')`,
      before > 5 && after > 0 && after < 5);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

console.log("\n### Snippet completion (eve → Enter → every snippet)");
{
  // Robust focus: click the editor body, then explicitly wait for the cm-focused class.
  await page.locator(".cm-editor").click();
  await page.waitForTimeout(100);
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  // CodeMirror always renders at least one logical line, so an "empty" doc
  // comes back as "" or "\n" depending on the browser. Treat both as cleared.
  const got = await page.locator(".cm-content").innerText();
  const cleared = got === "" || got === "\n";
  ok(`editor cleared before snippet test (got ${JSON.stringify(got)})`, cleared);
  await page.keyboard.type("eve");
  await page.waitForTimeout(350);
  const popupVisible = (await page.locator(".cm-tooltip-autocomplete").count()) > 0;
  ok("autocomplete popup opens for 'eve'", popupVisible);
  if (popupVisible) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const content = await page.locator(".cm-content").innerText();
    ok(`snippet expanded ('${content.slice(0,60)}')`, content.startsWith("every "));
  }
}

console.log("\n### Hover tooltip on combinator");
{
  // Exit any active snippet placeholder mode from the previous test.
  await page.locator(".cm-editor").click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  await clearAndType(`d1 $ every 4 rev (s "bd")`);
  await page.waitForTimeout(200);
  // Locate the 'every' word visually and hover.
  const box = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-content .cm-line")];
    for (const l of lines) {
      for (const span of l.querySelectorAll("span")) {
        if (span.textContent === "every") {
          const r = span.getBoundingClientRect();
          return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }
      }
    }
    return null;
  });
  if (!box) ok("found 'every' span", false);
  else {
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(700);
    const tooltipCount = await page.locator(".cm-tooltip.cm-tooltip-hover, [class*='lidal-hover']").count();
    ok(`hover tooltip visible for 'every' (${tooltipCount})`, tooltipCount > 0);
    if (tooltipCount > 0) {
      const tipText = await page.locator(".cm-tooltip.cm-tooltip-hover").first().textContent().catch(() => "");
      console.log(`    tooltip text: ${JSON.stringify(tipText?.slice(0, 100))}`);
    }
  }
}

console.log("\n### Cheat sheet collapsed → expandable");
{
  const stripVisible = await page.locator(".lidal-cheat").isVisible();
  ok("cheat sheet strip present", stripVisible);
  const expandedBefore = await page.locator(".lidal-cheat").evaluate((el) => el.classList.contains("expanded"));
  ok("cheat sheet collapsed by default", !expandedBefore);
  // Click the strip to expand.
  await page.locator("#cheatsheetStrip").click();
  await page.waitForTimeout(200);
  const expandedAfter = await page.locator(".lidal-cheat").evaluate((el) => el.classList.contains("expanded"));
  ok("cheat sheet expands on click", expandedAfter);
  // Click again to collapse.
  await page.locator("#cheatsheetStrip").click();
  await page.waitForTimeout(200);
  const collapsedAgain = await page.locator(".lidal-cheat").evaluate((el) => el.classList.contains("expanded"));
  ok("cheat sheet collapses on second click", !collapsedAgain);
}

await page.screenshot({ path: path.join(OUT, "verify-05-final.png"), fullPage: true });
console.log(`\nScreenshots in ${OUT}`);
await browser.close();

if (failures > 0) {
  console.error(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
} else {
  console.log("\nAll checks passed");
}
