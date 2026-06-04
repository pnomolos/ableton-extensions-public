// Inspect what classes the CM highlighter applies to specific characters.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(c => c.newPage());

await page.goto("http://localhost:7654/", { waitUntil: "load", timeout: 10_000 });
await page.waitForSelector(".cm-editor", { timeout: 5_000 });
await page.waitForTimeout(400);

// Dump every span inside .cm-content with its text + class + computed color.
const report = await page.evaluate(() => {
  const out = [];
  const lines = document.querySelectorAll(".cm-content .cm-line");
  lines.forEach((line, lineIdx) => {
    const items = [];
    line.querySelectorAll("*").forEach((node) => {
      if (node.children.length === 0) {
        const cs = getComputedStyle(node);
        items.push({
          text: node.textContent,
          tag: node.tagName.toLowerCase(),
          className: node.className,
          color: cs.color,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
        });
      }
    });
    // Also catch direct text node children of .cm-line (un-highlighted text)
    line.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
        items.push({
          text: n.textContent,
          tag: "text",
          className: "(none)",
          color: getComputedStyle(line).color,
        });
      }
    });
    if (items.length > 0) out.push({ lineIdx: lineIdx + 1, items });
  });
  return out;
});

for (const line of report) {
  console.log(`\nLine ${line.lineIdx}:`);
  for (const it of line.items) {
    console.log(`  ${JSON.stringify(it.text).padEnd(20)}  class=${it.className.padEnd(18)}  color=${it.color}`);
  }
}

await browser.close();
