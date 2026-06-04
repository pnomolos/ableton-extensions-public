// Lidal help overlay — a Cmd+? modal showing all keybindings, every
// combinator/constructor/signal with type signature + 1-line description,
// and the mini-notation cheat sheet.
//
// Implementation notes:
//   • The overlay is a single dialog element appended to <body> on demand and
//     left there (display:none when closed) so re-opens are instant.
//   • The data comes from help-data.ts; this file owns only presentation.
//   • CSS classes are all prefixed `lidal-help-*` to avoid collisions with
//     the editor chrome styles in editor-page.ts and with sibling agents'
//     work on the live-feedback panel.
//   • Search filters by case-insensitive substring against name +
//     description + signature; updates on every input.
//   • Arrow keys move a focused row; Enter just closes (we intentionally do
//     not auto-insert into the editor — see the task brief).
//
// Public API: openHelpOverlay() / closeHelpOverlay() / toggleHelpOverlay().
// The Cmd+? keybinding lives in client.ts; this module exposes the imperative
// API so the command palette can also open it.

import {
  HELP_CATEGORIES, HELP_ENTRIES, SHORTCUTS, MINI_NOTATION, DRUM_ALIASES,
  type HelpEntry, type HelpCategory,
} from "./help-data.js";

// ── DOM helpers (duplicated from client.ts to keep modules independent) ──

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Partial<Record<string, string>>,
  children?: (HTMLElement | string)[],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v != null) e.setAttribute(k, v);
  }
  if (children) for (const c of children) {
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

// ── Styles (injected once) ────────────────────────────────────────────────

const STYLE_ID = "lidal-help-overlay-style";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .lidal-help-backdrop {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(2px);
      animation: lidal-help-fade-in 120ms ease-out;
    }
    @keyframes lidal-help-fade-in { from { opacity: 0; } to { opacity: 1; } }

    .lidal-help-modal {
      width: min(80vw, 1080px);
      height: min(82vh, 800px);
      background: #1c1c1c;
      border: 1px solid #3a3a3a;
      border-radius: 6px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
      display: flex; flex-direction: column;
      color: #e8e8e8;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    }

    .lidal-help-header {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid #2a2a2a;
      background: #161616;
      border-radius: 6px 6px 0 0;
    }
    .lidal-help-title {
      font-size: 13px; font-weight: 600; letter-spacing: 0.3px;
      margin: 0;
    }
    .lidal-help-hint {
      color: #666; font-size: 11px;
      margin-left: auto;
    }
    .lidal-help-hint kbd {
      font-family: ui-monospace, Menlo, monospace;
      background: rgba(255,255,255,0.05); padding: 1px 5px;
      border-radius: 3px; border: 1px solid #2a2a2a;
      font-size: 10.5px; color: #999;
    }
    .lidal-help-close {
      padding: 3px 9px; font-size: 11px;
      background: #1c1c1c; color: #999;
      border: 1px solid #2a2a2a; border-radius: 3px;
      cursor: pointer;
    }
    .lidal-help-close:hover { color: #e8e8e8; background: #2a2a2a; }

    .lidal-help-searchbar {
      padding: 8px 14px;
      border-bottom: 1px solid #2a2a2a;
      background: #161616;
    }
    .lidal-help-search {
      width: 100%; background: #0e0e0e; color: #e8e8e8;
      border: 1px solid #2a2a2a; border-radius: 3px;
      padding: 6px 10px; font-size: 12.5px;
      font-family: inherit;
    }
    .lidal-help-search:focus { outline: none; border-color: #3a8a4a; }

    .lidal-help-body {
      flex: 1; overflow-y: auto;
      padding: 10px 14px 16px;
      scrollbar-width: thin; scrollbar-color: #2a2a2a transparent;
    }

    .lidal-help-section { margin-top: 14px; }
    .lidal-help-section:first-child { margin-top: 4px; }
    .lidal-help-section h2 {
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px;
      color: #6fb37b;
      margin: 0 0 4px;
      padding-bottom: 4px;
      border-bottom: 1px solid #2a2a2a;
    }
    .lidal-help-section .lidal-help-blurb {
      font-size: 11px; color: #666; margin: 0 0 8px;
    }

    .lidal-help-row {
      display: grid;
      grid-template-columns: 130px 1fr 230px;
      gap: 14px;
      padding: 5px 8px;
      border-radius: 3px;
      align-items: baseline;
      font-size: 12px;
      line-height: 1.5;
      transition: background 80ms;
    }
    .lidal-help-row:hover,
    .lidal-help-row.lidal-help-focus {
      background: rgba(255,255,255,0.05);
    }
    .lidal-help-row[hidden] { display: none; }
    .lidal-help-row .lidal-help-name {
      font-family: ui-monospace, Menlo, monospace;
      font-weight: 600;
      color: #7fb6d9;
    }
    .lidal-help-row.kind-orbit       .lidal-help-name { color: #6fb37b; }
    .lidal-help-row.kind-constructor .lidal-help-name { color: #e0a87a; }
    .lidal-help-row.kind-combinator  .lidal-help-name { color: #7fb6d9; }
    .lidal-help-row.kind-signal      .lidal-help-name { color: #c896e3; }
    .lidal-help-row.kind-function    .lidal-help-name { color: #cfd2d6; }

    .lidal-help-row .lidal-help-desc { color: #cfd2d6; }
    .lidal-help-row .lidal-help-desc .lidal-help-sig {
      display: block;
      font-family: ui-monospace, Menlo, monospace;
      font-size: 11px;
      color: #999;
      margin-bottom: 2px;
    }
    .lidal-help-row .lidal-help-example {
      font-family: ui-monospace, Menlo, monospace;
      font-size: 11px;
      color: #d9c187;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }

    /* Shortcuts table */
    .lidal-help-shortcuts {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 4px 16px;
      font-size: 12px;
    }
    .lidal-help-shortcuts kbd {
      font-family: ui-monospace, Menlo, monospace;
      background: rgba(255,255,255,0.05); padding: 1px 6px;
      border-radius: 3px; border: 1px solid #2a2a2a;
      font-size: 11px; color: #cfd2d6;
    }
    .lidal-help-shortcuts .lidal-help-shortcut-alt {
      color: #666; font-size: 10.5px; margin-left: 6px;
      font-family: ui-monospace, monospace;
    }

    /* Mini-notation table */
    .lidal-help-mini-row {
      display: grid;
      grid-template-columns: 130px 1fr 230px;
      gap: 14px;
      padding: 4px 8px;
      font-size: 12px;
      align-items: baseline;
      border-radius: 3px;
    }
    .lidal-help-mini-row:hover { background: rgba(255,255,255,0.05); }
    .lidal-help-mini-row[hidden] { display: none; }
    .lidal-help-mini-row .lidal-help-name,
    .lidal-help-mini-row .lidal-help-example {
      font-family: ui-monospace, Menlo, monospace;
    }
    .lidal-help-mini-row .lidal-help-name { color: #f0c469; }
    .lidal-help-mini-row .lidal-help-example { color: #d9c187; }

    .lidal-help-empty {
      color: #666; font-style: italic;
      padding: 14px; text-align: center; font-size: 12px;
    }

    /* Make the global cheat sheet dim while overlay is open */
    body.lidal-help-open .hint {
      opacity: 0.35; transition: opacity 120ms;
    }
  `;
  document.head.appendChild(style);
}

// ── Single-instance state ────────────────────────────────────────────────

let overlay: HTMLDivElement | null = null;
let modal: HTMLDivElement | null = null;
let searchInput: HTMLInputElement | null = null;
let bodyHost: HTMLDivElement | null = null;
let isOpen = false;
let lastFocus: HTMLElement | null = null;
let focusedRow: HTMLElement | null = null;

// ── Builders ──────────────────────────────────────────────────────────────

function buildShortcutsSection(): HTMLElement {
  const sec = el("section", { class: "lidal-help-section", "data-section": "shortcuts" });
  sec.appendChild(el("h2", {}, ["Keyboard shortcuts"]));
  const grid = el("div", { class: "lidal-help-shortcuts" });
  for (const s of SHORTCUTS) {
    const keysCell = el("div");
    const primary = el("kbd", {}, [s.keys]);
    keysCell.appendChild(primary);
    if (s.altKeys) {
      keysCell.appendChild(el("span", { class: "lidal-help-shortcut-alt" }, [s.altKeys]));
    }
    grid.appendChild(keysCell);
    grid.appendChild(el("div", {}, [s.description]));
  }
  sec.appendChild(grid);
  return sec;
}

function buildEntryRow(e: HelpEntry): HTMLElement {
  const row = el("div", {
    class: `lidal-help-row kind-${e.kind}`,
    role: "listitem",
    "data-name": e.name,
    "data-search-hay": `${e.name} ${e.signature} ${e.description}`.toLowerCase(),
    tabindex: "0",
  });
  row.appendChild(el("div", { class: "lidal-help-name" }, [e.name]));
  const desc = el("div", { class: "lidal-help-desc" });
  desc.appendChild(el("span", { class: "lidal-help-sig" }, [e.signature]));
  desc.appendChild(document.createTextNode(e.description));
  row.appendChild(desc);
  row.appendChild(el("div", { class: "lidal-help-example", title: e.example }, [e.example]));
  return row;
}

function buildCategorySection(cat: HelpCategory): HTMLElement | null {
  const entries = HELP_ENTRIES.filter((e) => e.category === cat);
  if (entries.length === 0) return null;
  const meta = HELP_CATEGORIES.find((c) => c.id === cat);
  const title = meta?.title ?? cat;
  const sec = el("section", { class: "lidal-help-section", "data-section": `cat-${cat}` });
  sec.appendChild(el("h2", {}, [title]));
  if (meta?.blurb) sec.appendChild(el("div", { class: "lidal-help-blurb" }, [meta.blurb]));
  for (const e of entries) sec.appendChild(buildEntryRow(e));
  return sec;
}

function buildMiniNotationSection(): HTMLElement {
  const sec = el("section", { class: "lidal-help-section", "data-section": "mini" });
  sec.appendChild(el("h2", {}, ["Mini-notation"]));
  sec.appendChild(el("div", { class: "lidal-help-blurb" }, [
    "Pattern-string syntax inside n / s / chord / mask / struct.",
  ]));
  for (const m of MINI_NOTATION) {
    const row = el("div", {
      class: "lidal-help-mini-row",
      "data-search-hay": `${m.syntax} ${m.meaning} ${m.example}`.toLowerCase(),
    });
    row.appendChild(el("div", { class: "lidal-help-name" }, [m.syntax]));
    row.appendChild(el("div", {}, [m.meaning]));
    row.appendChild(el("div", { class: "lidal-help-example", title: m.example }, [m.example]));
    sec.appendChild(row);
  }
  return sec;
}

function buildDrumNamesSection(): HTMLElement {
  const sec = el("section", { class: "lidal-help-section", "data-section": "drums" });
  sec.appendChild(el("h2", {}, ["Drum aliases (built-in)"]));
  sec.appendChild(el("div", { class: "lidal-help-blurb" }, [
    "Default MIDI mapping used by s \"…\". Override with drumMap or autoMap.",
  ]));
  for (const d of DRUM_ALIASES) {
    const row = el("div", {
      class: "lidal-help-mini-row",
      "data-search-hay": `${d.name} ${d.desc} ${d.midi}`.toLowerCase(),
    });
    row.appendChild(el("div", { class: "lidal-help-name" }, [d.name]));
    row.appendChild(el("div", {}, [d.desc]));
    row.appendChild(el("div", { class: "lidal-help-example" }, [`MIDI ${d.midi}`]));
    sec.appendChild(row);
  }
  return sec;
}

function buildOverlay(): void {
  ensureStyles();

  overlay = el("div", {
    class: "lidal-help-backdrop",
    id: "help-overlay",
    role: "presentation",
  }) as HTMLDivElement;

  modal = el("div", {
    class: "lidal-help-modal",
    id: "help-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "help-title",
  }) as HTMLDivElement;

  const header = el("div", { class: "lidal-help-header" });
  header.appendChild(el("h1", { class: "lidal-help-title", id: "help-title" }, ["Lidal — help & reference"]));
  const hint = el("span", { class: "lidal-help-hint" });
  hint.append(el("kbd", {}, ["Esc"]), document.createTextNode(" close"));
  header.appendChild(hint);
  const closeBtn = el("button", {
    type: "button",
    class: "lidal-help-close",
    "aria-label": "Close help overlay",
  }, ["Close"]);
  closeBtn.addEventListener("click", () => closeHelpOverlay());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const searchbar = el("div", { class: "lidal-help-searchbar" });
  searchInput = el("input", {
    type: "search",
    class: "lidal-help-search",
    id: "help-search",
    placeholder: "Filter (name, signature, description) — Esc clears, ⌘? closes",
    "aria-label": "Filter help entries",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  searchInput.addEventListener("input", () => applyFilter(searchInput!.value));
  searchbar.appendChild(searchInput);
  modal.appendChild(searchbar);

  bodyHost = el("div", { class: "lidal-help-body", id: "help-body" }) as HTMLDivElement;
  bodyHost.appendChild(buildShortcutsSection());
  for (const cat of HELP_CATEGORIES) {
    if (cat.id === "mini-notation") continue; // built separately below
    const sec = buildCategorySection(cat.id);
    if (sec) bodyHost.appendChild(sec);
  }
  bodyHost.appendChild(buildMiniNotationSection());
  bodyHost.appendChild(buildDrumNamesSection());
  modal.appendChild(bodyHost);

  overlay.appendChild(modal);

  // Click outside the modal closes the overlay.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeHelpOverlay();
  });

  document.body.appendChild(overlay);
}

// ── Filtering / navigation ────────────────────────────────────────────────

function applyFilter(needle: string): void {
  if (!bodyHost) return;
  const q = needle.trim().toLowerCase();

  const rows = bodyHost.querySelectorAll<HTMLElement>(".lidal-help-row, .lidal-help-mini-row");
  let visibleCount = 0;
  for (const row of rows) {
    const hay = row.dataset.searchHay ?? "";
    const match = !q || hay.includes(q);
    row.hidden = !match;
    if (match) visibleCount++;
  }

  // Hide sections whose content is now entirely filtered out (except the
  // shortcuts table which doesn't carry search hay).
  const sections = bodyHost.querySelectorAll<HTMLElement>(".lidal-help-section");
  for (const sec of sections) {
    const id = sec.dataset.section ?? "";
    if (id === "shortcuts") {
      sec.hidden = q.length > 0; // shortcuts hide on any search
      continue;
    }
    const anyVisible = Array.from(
      sec.querySelectorAll<HTMLElement>(".lidal-help-row, .lidal-help-mini-row"),
    ).some((r) => !r.hidden);
    sec.hidden = !anyVisible;
  }

  // Clear empty-state and prior focus.
  bodyHost.querySelector(".lidal-help-empty")?.remove();
  if (focusedRow) {
    focusedRow.classList.remove("lidal-help-focus");
    focusedRow = null;
  }

  if (visibleCount === 0 && q.length > 0) {
    bodyHost.appendChild(el("div", { class: "lidal-help-empty" }, [
      `No matches for "${needle}". Try a shorter prefix or check spelling.`,
    ]));
  }
}

function visibleRows(): HTMLElement[] {
  if (!bodyHost) return [];
  return Array.from(
    bodyHost.querySelectorAll<HTMLElement>(".lidal-help-row, .lidal-help-mini-row"),
  ).filter((r) => !r.hidden);
}

function focusRow(target: HTMLElement | null): void {
  if (focusedRow) focusedRow.classList.remove("lidal-help-focus");
  focusedRow = target;
  if (target) {
    target.classList.add("lidal-help-focus");
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function moveFocus(delta: number): void {
  const rows = visibleRows();
  if (rows.length === 0) return;
  const cur = focusedRow ? rows.indexOf(focusedRow) : -1;
  let next = cur + delta;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  focusRow(rows[next]);
}

// ── Open / close API ──────────────────────────────────────────────────────

// Focus-trap helpers (TOFIX smaller-fix): keep Tab focus inside the modal
// while it's open. Tabbable elements = anchors, buttons, inputs, selects,
// textareas, anything with explicit tabindex >= 0. Within the modal there
// are very few: search input, close button, focused row.
function tabbableInModal(): HTMLElement[] {
  if (!modal) return [];
  const candidates = modal.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  // Filter out anything not visible (display:none / hidden=""). querySelectorAll
  // returns elements in document order which is also tab order.
  const out: HTMLElement[] = [];
  for (const el of candidates) {
    if (el.hidden) continue;
    if (el.offsetParent === null && el !== document.activeElement) continue;
    out.push(el);
  }
  return out;
}

function trapTab(e: KeyboardEvent): boolean {
  const items = tabbableInModal();
  if (items.length === 0) return false;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey) {
    if (active === first || !modal?.contains(active)) {
      e.preventDefault();
      last.focus();
      return true;
    }
  } else {
    if (active === last || !modal?.contains(active)) {
      e.preventDefault();
      first.focus();
      return true;
    }
  }
  return false;
}

function onKey(e: KeyboardEvent): void {
  if (!isOpen) return;
  if (e.key === "Tab") {
    if (trapTab(e)) return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    // Clear search first if it has content; otherwise close.
    if (searchInput && searchInput.value !== "") {
      searchInput.value = "";
      applyFilter("");
      return;
    }
    closeHelpOverlay();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveFocus(1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    moveFocus(-1);
    return;
  }
  if (e.key === "Enter") {
    // Per the task spec: don't auto-insert. Just close so the user can apply
    // what they learned.
    e.preventDefault();
    closeHelpOverlay();
    return;
  }
  // Toggle: ⌘? again closes. We handle both forms because Cmd+Shift+/ is what
  // most layouts produce when the user thinks "Cmd+?".
  const isMod = e.metaKey || e.ctrlKey;
  if (isMod && (e.key === "?" || (e.shiftKey && e.key === "/"))) {
    e.preventDefault();
    closeHelpOverlay();
  }
}

export function openHelpOverlay(): void {
  if (isOpen) return;
  if (!overlay) buildOverlay();
  if (!overlay || !searchInput) return;
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add("lidal-help-open");
  overlay.style.display = "flex";
  isOpen = true;
  // Reset search on each open so the user starts fresh.
  searchInput.value = "";
  applyFilter("");
  // Focus the search input so typing immediately filters.
  setTimeout(() => searchInput?.focus(), 0);
  document.addEventListener("keydown", onKey, true);
}

export function closeHelpOverlay(): void {
  if (!isOpen || !overlay) return;
  overlay.style.display = "none";
  document.body.classList.remove("lidal-help-open");
  isOpen = false;
  document.removeEventListener("keydown", onKey, true);
  if (lastFocus && document.contains(lastFocus)) {
    try { lastFocus.focus(); } catch { /* ignore */ }
  }
}

export function toggleHelpOverlay(): void {
  if (isOpen) closeHelpOverlay();
  else openHelpOverlay();
}

export function isHelpOpen(): boolean {
  return isOpen;
}
