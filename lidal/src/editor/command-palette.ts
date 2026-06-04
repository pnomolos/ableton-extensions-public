// Command palette — Cmd+P opens a modal listing the editor's runnable
// commands. Each entry has a label, an optional shortcut hint, and an action
// callback. The host (client.ts) registers commands at startup via
// `registerCommands(...)`.
//
// The palette deliberately stays minimal — no fuzzy matching, just
// substring filtering on the label. Arrow keys move selection, Enter runs.
// Esc closes (or clears the search box first if it's non-empty).
//
// CSS class prefix: `lidal-palette-*`. DOM IDs: `#palette-*`.

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;        // e.g. "⌘↵" — shown right-aligned in the row
  detail?: string;      // optional short description shown below label
  run: () => void;      // action to execute when selected
}

const STYLE_ID = "lidal-palette-style";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .lidal-palette-backdrop {
      position: fixed; inset: 0; z-index: 9100;
      background: rgba(0, 0, 0, 0.45);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 12vh;
      animation: lidal-palette-fade-in 100ms ease-out;
    }
    @keyframes lidal-palette-fade-in { from { opacity: 0; } to { opacity: 1; } }

    .lidal-palette-modal {
      width: min(620px, 88vw);
      max-height: 60vh;
      background: #1c1c1c;
      border: 1px solid #3a3a3a;
      border-radius: 6px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
      display: flex; flex-direction: column;
      color: #e8e8e8;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    }

    .lidal-palette-search {
      width: 100%;
      background: transparent;
      border: none;
      border-bottom: 1px solid #2a2a2a;
      padding: 10px 14px;
      font-size: 13px;
      color: #e8e8e8;
      font-family: inherit;
    }
    .lidal-palette-search:focus { outline: none; }
    .lidal-palette-search::placeholder { color: #666; }

    .lidal-palette-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
      scrollbar-width: thin; scrollbar-color: #2a2a2a transparent;
    }

    .lidal-palette-row {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 14px;
      font-size: 12.5px;
      cursor: pointer;
      transition: background 60ms;
    }
    .lidal-palette-row[hidden] { display: none; }
    .lidal-palette-row:hover { background: rgba(255,255,255,0.04); }
    .lidal-palette-row.lidal-palette-active {
      background: #2d6a3a;
      color: #fff;
    }
    .lidal-palette-row .lidal-palette-text { flex: 1; min-width: 0; }
    .lidal-palette-row .lidal-palette-label {
      font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .lidal-palette-row .lidal-palette-detail {
      font-size: 10.5px;
      color: #999;
      margin-top: 1px;
    }
    .lidal-palette-row.lidal-palette-active .lidal-palette-detail { color: #d8e9dd; }
    .lidal-palette-row .lidal-palette-hint {
      font-family: ui-monospace, Menlo, monospace;
      font-size: 10.5px;
      color: #999;
      background: rgba(255,255,255,0.05);
      padding: 1px 6px;
      border-radius: 3px;
      border: 1px solid #2a2a2a;
      flex-shrink: 0;
    }
    .lidal-palette-row.lidal-palette-active .lidal-palette-hint {
      color: #fff; background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.15);
    }

    .lidal-palette-empty {
      padding: 14px;
      color: #666;
      font-style: italic;
      text-align: center;
      font-size: 12px;
    }
  `;
  document.head.appendChild(style);
}

// ── Module state ─────────────────────────────────────────────────────────

const commands: PaletteCommand[] = [];
let overlay: HTMLDivElement | null = null;
let modal: HTMLDivElement | null = null;
let searchInput: HTMLInputElement | null = null;
let list: HTMLDivElement | null = null;
let isOpen = false;
let activeIndex = 0;
let visibleCommands: PaletteCommand[] = [];
let lastFocus: HTMLElement | null = null;

// ── Public API ────────────────────────────────────────────────────────────

export function registerPaletteCommands(cmds: PaletteCommand[]): void {
  // Replace by id (idempotent across re-registration).
  for (const c of cmds) {
    const idx = commands.findIndex((x) => x.id === c.id);
    if (idx >= 0) commands[idx] = c;
    else commands.push(c);
  }
}

export function isPaletteOpen(): boolean {
  return isOpen;
}

// ── Build / render ────────────────────────────────────────────────────────

function buildOverlay(): void {
  ensureStyles();

  overlay = document.createElement("div");
  overlay.className = "lidal-palette-backdrop";
  overlay.id = "palette-overlay";
  overlay.setAttribute("role", "presentation");

  modal = document.createElement("div");
  modal.className = "lidal-palette-modal";
  modal.id = "palette-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Command palette");

  searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "lidal-palette-search";
  searchInput.id = "palette-search";
  searchInput.placeholder = "Type to filter commands… (Esc to close)";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.setAttribute("aria-label", "Filter commands");
  searchInput.addEventListener("input", () => {
    renderList(searchInput!.value);
  });
  modal.appendChild(searchInput);

  list = document.createElement("div");
  list.className = "lidal-palette-list";
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  modal.appendChild(list);

  overlay.appendChild(modal);

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePalette();
  });

  document.body.appendChild(overlay);
}

function renderList(filterText: string): void {
  if (!list) return;
  const q = filterText.trim().toLowerCase();
  list.innerHTML = "";
  visibleCommands = q
    ? commands.filter((c) => {
        const hay = `${c.label} ${c.detail ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
    : commands.slice();

  if (visibleCommands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lidal-palette-empty";
    empty.textContent = q ? `No commands match "${filterText}".` : "No commands registered.";
    list.appendChild(empty);
    activeIndex = 0;
    return;
  }

  visibleCommands.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "lidal-palette-row";
    row.setAttribute("role", "option");
    row.dataset.index = String(i);
    row.addEventListener("click", () => {
      activeIndex = i;
      runActive();
    });
    row.addEventListener("mouseenter", () => {
      setActive(i);
    });

    const text = document.createElement("div");
    text.className = "lidal-palette-text";
    const label = document.createElement("div");
    label.className = "lidal-palette-label";
    label.textContent = c.label;
    text.appendChild(label);
    if (c.detail) {
      const detail = document.createElement("div");
      detail.className = "lidal-palette-detail";
      detail.textContent = c.detail;
      text.appendChild(detail);
    }
    row.appendChild(text);

    if (c.hint) {
      const hint = document.createElement("span");
      hint.className = "lidal-palette-hint";
      hint.textContent = c.hint;
      row.appendChild(hint);
    }

    list!.appendChild(row);
  });

  activeIndex = 0;
  highlightActive();
}

function setActive(i: number): void {
  if (i < 0) i = 0;
  if (i >= visibleCommands.length) i = visibleCommands.length - 1;
  activeIndex = i;
  highlightActive();
}

function highlightActive(): void {
  if (!list) return;
  const rows = list.querySelectorAll<HTMLElement>(".lidal-palette-row");
  rows.forEach((r, i) => {
    if (i === activeIndex) {
      r.classList.add("lidal-palette-active");
      r.scrollIntoView({ block: "nearest" });
    } else {
      r.classList.remove("lidal-palette-active");
    }
  });
}

function runActive(): void {
  const cmd = visibleCommands[activeIndex];
  if (!cmd) return;
  closePalette();
  // Defer to the next tick so the modal teardown completes before the command
  // (which may itself open another overlay) runs.
  setTimeout(() => {
    try { cmd.run(); }
    catch (e) { console.error("[Lidal] palette command failed", e); }
  }, 0);
}

// ── Keyboard ─────────────────────────────────────────────────────────────

// Focus-trap (TOFIX smaller-fix): keep Tab focus inside the palette modal so
// the user can't accidentally tab back into the editor while filtering. The
// palette has only the search input + the list rows are not tabbable, so we
// just round-trip Tab back to the search.
function trapTab(e: KeyboardEvent): boolean {
  if (!modal || !searchInput) return false;
  // Single focusable element — always loop back to it.
  e.preventDefault();
  searchInput.focus();
  return true;
}

function onKey(e: KeyboardEvent): void {
  if (!isOpen) return;
  if (e.key === "Tab") {
    if (trapTab(e)) return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (searchInput && searchInput.value !== "") {
      searchInput.value = "";
      renderList("");
      return;
    }
    closePalette();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    runActive();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActive(activeIndex + 1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    setActive(activeIndex - 1);
    return;
  }
  // Cmd+P / Ctrl+P toggles.
  if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    closePalette();
  }
}

// ── Open / close ─────────────────────────────────────────────────────────

export function openPalette(): void {
  if (isOpen) return;
  if (!overlay) buildOverlay();
  if (!overlay || !searchInput) return;
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.style.display = "flex";
  isOpen = true;
  searchInput.value = "";
  renderList("");
  setTimeout(() => searchInput?.focus(), 0);
  document.addEventListener("keydown", onKey, true);
}

export function closePalette(): void {
  if (!isOpen || !overlay) return;
  overlay.style.display = "none";
  isOpen = false;
  document.removeEventListener("keydown", onKey, true);
  if (lastFocus && document.contains(lastFocus)) {
    try { lastFocus.focus(); } catch { /* ignore */ }
  }
}

export function togglePalette(): void {
  if (isOpen) closePalette();
  else openPalette();
}
