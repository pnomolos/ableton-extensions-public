// Shell HTML for the Lidal editor. CodeMirror 6 + all interactive behaviour
// lives in a separate bundle served at /editor-client.js; this file owns only
// the chrome (header, controls, log panel scaffolding, banner) and the CSS.
// The client script is loaded at the end of <body> and mounts CM into
// `#editor-host`.

export function editorPage(opts: {
  notesPort: string;
  drumsPort: string;
  controlPort?: string;
  defaultBuffer: string;
  /**
   * Per-launch CSRF token. Embedded in the page as a `data-csrf-token`
   * attribute on #editor-host so client.ts can read it without an extra round
   * trip. The token is required on every POST (`x-lidal-token` header) and
   * on the SSE connection (`?t=…` query param, because EventSource has no
   * header API). See server.ts for the matching server-side validation.
   */
  csrfToken: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lidal</title>
<style>
  /* ── Consolidated palette ─────────────────────────────────────────────────
   * 9 conceptual colors. Tinted *-bg/*-border vars are darker/lighter alloys
   * of the base hue and live with their owners (accent/danger/warn) so the
   * mapping is obvious. WCAG: --fg has 14.4:1 vs --bg, --fg-dim has 7.4:1
   * (AAA for body), --fg-faint has 3.7:1 (AA for chrome/labels only).
   *
   *   --bg              page background
   *   --surface         every elevated chrome surface (header, log, buttons,
   *                     inputs, status pill) — input recess is signalled via
   *                     --border, not a darker fill
   *   --border          default chrome divider
   *   --border-strong   focused / active chrome (input outline, primary btn)
   *   --fg              default text
   *   --fg-dim          secondary text (labels, log meta)
   *   --fg-faint        faint text (timestamps, hints, faint dividers)
   *   --accent          success / running (also editor caret, focus ring)
   *   --danger          errors
   *   --warn            warnings (Link unavailable etc.)
   *
   * The *-bg / *-border tints are not new colors — they're the same hue at
   * filled-pill saturation. */
  :root {
    --bg: #121212;
    --surface: #1c1c1c;
    --border: #2a2a2a;
    --border-strong: #3a3a3a;
    --fg: #e8e8e8;
    --fg-dim: #a0a0a0;
    --fg-faint: #707070;
    --accent: #6fb37b;
    --accent-hover: #82c48e;
    --accent-bg: #2d6a3a;
    --accent-border: #3a8a4a;
    --danger: #e07474;
    --danger-hover: #ea8484;
    --danger-bg: #6a2d2d;
    --danger-border: #8a3a3a;
    --warn: #e0a87a;
    --warn-bg: #5a4020;
    --warn-border: #8a6638;
    /* Aliases kept for sibling-agent compatibility (live-feedback,
       discoverability). They resolve to the same single surface. */
    --bg-elevated: var(--surface);
    --bg-input: var(--surface);

    /* Common timing tokens — used by transitions across the chrome. */
    --t-fast: 80ms ease;
    --t-med: 150ms ease;
    --t-slow: 200ms ease;
  }
  @keyframes chrome-row-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes chrome-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
  body { display: flex; flex-direction: column; }

  header {
    display: flex; align-items: center; gap: 14px;
    padding: 10px 18px; border-bottom: 1px solid var(--border);
    background: var(--surface);
    min-height: 44px;
  }
  header h1 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; flex-shrink: 0; }
  header .ports { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: var(--fg-faint); margin-left: 8px; }

  /* Status pill — monospace for the live mode/orbit info; cross-fades on
     text changes so state transitions register without flashing. */
  #status-pill {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px; padding: 4px 12px; border-radius: 999px;
    border: 1px solid var(--border-strong); background: var(--bg);
    color: var(--fg-dim);
    transition:
      background var(--t-med), color var(--t-med), border-color var(--t-med),
      opacity var(--t-slow);
    margin-left: auto;
    max-width: 60%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    will-change: opacity;
  }
  #status-pill.fading { opacity: 0.35; }
  #status-pill.running { color: #fff; background: var(--accent-bg); border-color: var(--accent-border); }
  #status-pill.error { color: #fff; background: var(--danger-bg); border-color: var(--danger-border); }
  #status-pill.disconnected { color: var(--warn); border-color: var(--warn-border); }
  #status-pill.warn { color: #fff; background: var(--warn-bg); border-color: var(--warn-border); }

  /* Cycle indicator — small ring next to the status pill. */
  .lidal-feedback-cycle-ring {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px;
    flex-shrink: 0;
    margin-left: auto;
    transition: opacity 0.2s;
    opacity: 1;
  }
  .lidal-feedback-cycle-ring.paused { opacity: 0.35; }
  .lidal-feedback-cycle-ring.hidden { display: none; }
  /* When the cycle ring is present, it owns the auto-margin pushing the
     right-side cluster. The status pill should sit adjacent to it. */
  .lidal-feedback-cycle-ring + #status-pill { margin-left: 0; }

  /* Orbit monitor strip — sits between the header and the editor. */
  #orbit-monitor {
    display: flex; gap: 8px; align-items: center;
    padding: 8px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    min-height: 38px;
    overflow-x: auto; overflow-y: hidden;
    flex-wrap: nowrap;
  }
  #orbit-monitor.empty { display: none; }

  /* Default — legacy small pills (kept for safety while migrating). */
  .orbit-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border-strong); background: var(--bg);
    font-family: ui-monospace, Menlo, monospace; font-size: 11px;
    color: var(--fg-dim);
    position: relative;
    flex-shrink: 0;
  }

  /* New per-orbit pills — bigger, per-orbit accent, fire indicator. */
  .lidal-feedback-orbit-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 4px 10px 4px 12px;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: var(--bg-input);
    font-family: ui-monospace, Menlo, monospace; font-size: 11.5px;
    color: var(--fg-dim);
    position: relative;
    flex-shrink: 0;
    line-height: 1.2;
    border-left-width: 3px;
    transition: opacity 0.6s ease, filter 0.6s ease;
  }
  .lidal-feedback-orbit-pill.fading { opacity: 0.25; filter: saturate(0.4); }
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-name {
    font-weight: 700; letter-spacing: 0.2px;
  }
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-meta {
    color: var(--fg-faint); font-size: 10.5px;
  }
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-val {
    color: var(--fg-dim); font-weight: 500;
  }
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-cycle {
    color: var(--fg-faint); font-size: 10px;
  }
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-fire {
    width: 7px; height: 7px; border-radius: 50%;
    background: currentColor; opacity: 0.22;
    flex-shrink: 0;
  }
  .lidal-feedback-orbit-pill.firing .lidal-feedback-orbit-fire {
    animation: lidal-feedback-orbit-fire 380ms ease-out;
  }
  @keyframes lidal-feedback-orbit-fire {
    0%   { opacity: 1;    transform: scale(1.7); box-shadow: 0 0 6px currentColor; }
    60%  { opacity: 0.8;  transform: scale(1.2); box-shadow: 0 0 3px currentColor; }
    100% { opacity: 0.22; transform: scale(1);   box-shadow: 0 0 0 currentColor; }
  }
  /* CC meter — a thin horizontal bar 0..127. */
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-meter {
    position: relative;
    width: 48px; height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }
  .lidal-feedback-orbit-pill .lidal-feedback-orbit-meter-fill {
    position: absolute; left: 0; top: 0; bottom: 0;
    background: currentColor;
    width: 0%;
    transition: width 0.12s linear;
  }

  /* CodeMirror in-editor orbit colouring. The ViewPlugin tags each occurrence
     with .lidal-feedback-orbit-<id>; the host page's <style> block emits the
     per-id rules. Bold matches the existing tokenizer style. */
  .cm-line .lidal-feedback-orbit-token { font-weight: 600; }

  /* Bake toast — fades in/out at the bottom of <main>. */
  .lidal-feedback-bake-toast {
    position: fixed;
    left: 50%; bottom: 24px;
    transform: translate(-50%, 14px);
    padding: 8px 14px;
    border-radius: 6px;
    background: var(--accent-bg);
    border: 1px solid var(--accent-border);
    color: #fff;
    font-size: 12px; font-weight: 600;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    pointer-events: none;
    opacity: 0; visibility: hidden;
    transition: opacity 0.18s ease, transform 0.22s ease, visibility 0.22s linear;
    z-index: 50;
    max-width: 70vw;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .lidal-feedback-bake-toast.visible {
    opacity: 1; visibility: visible;
    transform: translate(-50%, 0);
  }

  /* Legacy fallbacks (in case stale state.monitorByOrbit renders the old DOM). */
  .orbit-pill.note { color: var(--accent); }
  .orbit-pill.ctrl { color: #7fb6d9; }
  .orbit-pill .orbit-name { font-weight: 600; }
  .orbit-pill .orbit-val,
  .orbit-pill .orbit-cc { color: var(--fg-dim); }
  .orbit-pill .orbit-fire {
    width: 6px; height: 6px; border-radius: 999px;
    background: currentColor; opacity: 0.25;
  }
  .orbit-pill.pulse .orbit-fire {
    animation: orbit-fire-pulse 350ms ease-out;
  }
  @keyframes orbit-fire-pulse {
    0% { opacity: 1; transform: scale(1.7); }
    100% { opacity: 0.25; transform: scale(1); }
  }
  .orbit-overflow {
    font-size: 11px; color: var(--fg-faint);
    padding: 2px 6px;
    font-family: ui-monospace, monospace;
  }

  /* First-run banner */
  #banner {
    display: none;
    padding: 10px 18px;
    border-bottom: 1px solid var(--accent-border);
    background: rgba(45, 106, 58, 0.18);
    color: var(--fg);
    font-size: 12px;
    line-height: 1.5;
  }
  #banner.visible { display: block; }
  #banner .banner-row {
    display: flex; align-items: center; gap: 10px;
  }
  #banner .banner-text { flex: 1; }
  #banner button {
    padding: 4px 10px; font-size: 11px; font-weight: 600;
    border: 1px solid var(--border-strong); border-radius: 3px;
    background: var(--surface); color: var(--fg);
    cursor: pointer; font-family: inherit;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  #banner button:hover { background: #262626; border-color: #4a4a4a; }
  #banner button.primary { background: var(--accent-bg); border-color: var(--accent-border); color: #fff; }
  #banner button.primary:hover { background: #357d44; border-color: var(--accent); }
  #banner .banner-details {
    display: none;
    margin-top: 10px; padding: 10px 12px;
    background: rgba(0,0,0,0.25); border-radius: 4px;
    font-size: 11.5px; color: var(--fg-dim);
  }
  #banner .banner-details.open { display: block; }
  #banner code {
    font-family: ui-monospace, monospace; color: var(--accent);
    background: rgba(255,255,255,0.04); padding: 1px 5px; border-radius: 2px;
  }

  main { flex: 1; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }

  /* Collapsible cheat sheet (replaces the older .hint block) */
  .lidal-cheat {
    border-top: 1px solid var(--border);
    padding-top: 8px;
    font-size: 11px;
    color: var(--fg-dim);
  }
  .lidal-cheat-strip {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 2px;
    cursor: pointer;
    user-select: none;
    color: var(--fg-faint);
    font-size: 11px;
  }
  .lidal-cheat-strip:hover { color: var(--fg-dim); }
  .lidal-cheat-strip:focus-visible { outline: 2px solid var(--accent-border); outline-offset: 2px; border-radius: 3px; }
  .lidal-cheat-strip .lidal-cheat-chevron {
    display: inline-block; width: 10px; color: var(--fg-faint);
    transition: transform 120ms;
  }
  .lidal-cheat.expanded .lidal-cheat-strip .lidal-cheat-chevron { transform: rotate(90deg); }
  .lidal-cheat-strip .lidal-cheat-strip-hint kbd {
    font-family: ui-monospace, Menlo, monospace;
    background: rgba(255,255,255,0.04); padding: 1px 5px;
    border-radius: 3px; border: 1px solid var(--border-strong);
    font-size: 10.5px; color: var(--fg-dim);
  }
  .lidal-cheat-body { display: none; padding-top: 8px; line-height: 1.7; }
  .lidal-cheat.expanded .lidal-cheat-body { display: block; }
  .lidal-cheat .row { margin-bottom: 4px; }
  .lidal-cheat code {
    font-family: ui-monospace, Menlo, monospace; color: var(--fg-dim);
    background: rgba(255,255,255,0.04); padding: 1px 6px; border-radius: 3px;
  }
  .lidal-cheat kbd {
    font-family: ui-monospace, Menlo, monospace; color: var(--fg-dim);
    background: rgba(255,255,255,0.04); padding: 1px 6px; border-radius: 3px;
    border: 1px solid var(--border-strong); font-size: 10.5px;
  }
  /* When the help overlay opens, the page-level cheat sheet visually
     de-emphasises (the overlay itself toggles body.lidal-help-open). */
  body.lidal-help-open .lidal-cheat { opacity: 0.35; transition: opacity 120ms; }

  /* Editor host — CM6 mounts into this. */
  .editor-wrap { flex: 1; position: relative; min-height: 200px; display: flex; }
  #editor-host { flex: 1; display: flex; min-height: 0; min-width: 0; }
  /* CodeMirror's root container fills the host. */
  #editor-host .cm-editor { flex: 1; min-height: 0; min-width: 0; }
  /* Fallback while the bundle is still loading: show something readable. */
  #editor-fallback {
    width: 100%; height: 100%;
    background: var(--surface); color: var(--fg);
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14px;
    padding: 14px 16px; white-space: pre; overflow: auto;
    border: 1px solid var(--border); border-radius: 4px;
    line-height: 1.55;
  }

  .controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label {
    font-size: 10px; color: var(--fg-faint);
    text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600;
  }
  .field input, .field select {
    width: 90px; background: var(--surface); color: var(--fg);
    border: 1px solid var(--border-strong); border-radius: 3px;
    padding: 5px 8px; font-size: 13px;
    font-family: ui-monospace, Menlo, monospace;
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .field select { width: 130px; font-family: inherit; }
  .field input:hover, .field select:hover { border-color: #4a4a4a; }
  .field input:focus, .field select:focus { outline: none; border-color: var(--accent); }

  .spacer { flex: 1; }

  button {
    padding: 8px 16px; font-size: 12px; font-weight: 600;
    border: 1px solid var(--border-strong); border-radius: 4px;
    background: var(--surface); color: var(--fg);
    cursor: pointer; font-family: inherit;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  button:hover { background: #262626; border-color: #4a4a4a; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent-bg); border-color: var(--accent-border); color: #fff; }
  button.primary:hover { background: #357d44; border-color: var(--accent); }
  button.danger { background: var(--danger-bg); border-color: var(--danger-border); color: #fff; }
  button.danger:hover { background: #7d3535; border-color: var(--danger); }

  /* Keyboard-chip "kbd" — consistent monospace shortcut indicators used
     inline in headers, button labels, and the hint footer. */
  kbd, .chrome-kbd {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10.5px; color: var(--fg-dim);
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    padding: 1px 6px;
    box-shadow: 0 1px 0 rgba(0,0,0,0.4);
    white-space: nowrap;
  }
  button kbd, button .chrome-kbd {
    background: rgba(0,0,0,0.25);
    border-color: rgba(255,255,255,0.18);
    color: rgba(255,255,255,0.85);
    box-shadow: none;
    margin-left: 6px;
  }

  /* Log panel */
  .log-panel {
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--surface); overflow: hidden;
  }
  .log-header {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 12px; cursor: pointer;
    user-select: none;
    font-size: 11px; color: var(--fg-dim);
    border-bottom: 1px solid transparent;
    transition: background var(--t-fast);
  }
  .log-header:hover { background: rgba(255,255,255,0.04); }
  .log-panel.open .log-header { border-bottom-color: var(--border); }
  .log-toggle { width: 12px; display: inline-block; color: var(--fg-faint); transition: transform var(--t-fast); }
  .log-title { font-weight: 600; color: var(--fg-dim); letter-spacing: 0.2px; }
  .log-badge {
    font-family: ui-monospace, Menlo, monospace; font-size: 10px;
    color: var(--fg-faint); padding: 1px 7px; border-radius: 999px;
    background: var(--bg); border: 1px solid var(--border);
  }
  .log-actions { margin-left: auto; display: flex; gap: 6px; }
  .log-actions button {
    padding: 3px 10px; font-size: 10.5px; font-weight: 500;
    border-radius: 3px; background: var(--bg); color: var(--fg-dim);
    border: 1px solid var(--border);
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .log-actions button:hover { background: #262626; color: var(--fg); border-color: var(--border-strong); }
  .log-filters {
    display: none;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: rgba(0,0,0,0.22);
    gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .log-panel.open .log-filters { display: flex; }
  .log-search input {
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 4px 8px; font-size: 11px; width: 160px;
    font-family: inherit;
    transition: border-color var(--t-fast);
  }
  .log-search input:focus { outline: none; border-color: var(--accent); }
  .log-chip-group {
    display: inline-flex; gap: 4px;
    padding-left: 8px; margin-left: 4px;
    border-left: 1px solid var(--border);
  }
  .log-chip {
    padding: 2px 8px; font-size: 10px; font-weight: 600;
    border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border-strong);
    background: var(--bg); color: var(--fg-faint);
    text-transform: uppercase; letter-spacing: 0.4px;
    font-family: inherit;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast), opacity var(--t-fast);
  }
  .log-chip.active { color: var(--fg); background: var(--surface); }
  .log-chip.active.lvl-error  { border-color: var(--danger-border);   color: var(--danger); }
  .log-chip.active.lvl-warn   { border-color: var(--warn-border);     color: var(--warn); }
  .log-chip.active.lvl-info   { border-color: var(--accent-border);   color: var(--accent); }
  .log-chip.active.lvl-debug  { border-color: var(--border-strong);   color: var(--fg-dim); }
  .log-chip:not(.active) { opacity: 0.55; }
  .log-chip:not(.active):hover { opacity: 0.85; }
  .log-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .log-body {
    display: none;
    height: 200px; overflow-y: auto;
    background: var(--bg);
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px;
    line-height: 1.55;
  }
  .log-panel.open .log-body { display: block; }
  .log-empty {
    padding: 14px; color: var(--fg-faint); font-style: italic;
    text-align: center;
  }
  .log-row {
    padding: 3px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.025);
    white-space: pre-wrap; word-break: break-word;
    cursor: default;
  }
  /* Subtle slide-and-fade for newly-inserted rows. The .new class is
     applied for ~250ms by the client, then removed. */
  .log-row.new { animation: chrome-row-in 200ms ease-out; }
  .log-row.has-detail { cursor: pointer; }
  .log-row.has-detail:hover { background: rgba(255,255,255,0.04); }
  .log-row .log-ts { color: var(--fg-faint); }
  .log-row .log-lvl {
    display: inline-block; min-width: 44px;
    text-align: left; margin: 0 6px;
    font-weight: 600; letter-spacing: 0.4px;
  }
  .log-row .log-src { color: var(--fg-faint); margin-right: 6px; text-transform: lowercase; }
  .log-row .log-expand { display: inline-block; width: 10px; color: var(--fg-faint); margin-right: 4px; }
  .log-row.error .log-lvl, .log-row.error .log-msg { color: var(--danger); }
  .log-row.warn  .log-lvl, .log-row.warn  .log-msg { color: var(--warn); }
  .log-row.info  .log-msg { color: var(--fg-dim); }
  .log-row.debug .log-msg { color: var(--fg-faint); }
  .log-row.info  .log-lvl { color: var(--fg-dim); }
  .log-row.debug .log-lvl { color: var(--fg-faint); }
  .log-detail {
    display: none;
    margin-top: 4px; padding: 6px 8px;
    background: rgba(0,0,0,0.25);
    border-left: 2px solid var(--border-strong);
    color: var(--fg-faint); font-size: 11px;
    white-space: pre-wrap;
  }
  .log-row.open .log-detail { display: block; }

  .hint {
    font-size: 11px; color: var(--fg-faint); line-height: 1.75;
    border-top: 1px solid var(--border); padding-top: 14px;
  }
  .hint code {
    font-family: ui-monospace, Menlo, monospace; color: var(--fg-dim);
    background: rgba(255,255,255,0.04); padding: 1px 6px; border-radius: 3px;
    /* kbd is styled globally above; .hint inherits that without override */
  }
  .hint .row { margin-bottom: 5px; }
</style>
</head>
<body>
  <header>
    <h1>Lidal<span class="ports">&nbsp;notes → ${escHtml(opts.notesPort)} · drums → ${escHtml(opts.drumsPort)}${opts.controlPort ? ` · cc → ${escHtml(opts.controlPort)}` : ""}</span></h1>
    <div id="status-pill" role="status" aria-live="polite">connecting…</div>
  </header>

  <div id="orbit-monitor" class="empty" role="status" aria-live="off" aria-label="Active orbits"></div>

  <div id="banner" role="region" aria-label="Welcome">
    <div class="banner-row">
      <div class="banner-text">
        <strong>Welcome to Lidal.</strong> Create 3 MIDI tracks in Live and set their inputs to
        <code>Lidal Notes</code>, <code>Lidal Drums</code>, and <code>Lidal Control</code>.
      </div>
      <button type="button" data-action="show" aria-expanded="false">Show me how</button>
      <button type="button" class="primary" data-action="dismiss">Got it</button>
    </div>
    <div class="banner-details">
      <ol style="margin: 0; padding-left: 18px;">
        <li>In Live, create a MIDI track. In its <em>MIDI From</em> chooser, pick <code>${escHtml(opts.notesPort)}</code>. Arm it for recording (or set Monitor to <em>In</em>) and route its output to your synth.</li>
        <li>Create a second MIDI track. <em>MIDI From</em> → <code>${escHtml(opts.drumsPort)}</code>. Route its output to a Drum Rack.</li>
        ${opts.controlPort ? `<li>Create a third MIDI track. <em>MIDI From</em> → <code>${escHtml(opts.controlPort)}</code>. CC messages from <code>c1</code>..<code>c8</code> land here; map them with Live's MIDI-map mode (⌘M).</li>` : ""}
        <li>Type a pattern, then press <kbd>⌘↵</kbd> to evaluate the block under the cursor. <kbd>⌘.</kbd> hushes all orbits.</li>
      </ol>
    </div>
  </div>

  <main>
    <div class="editor-wrap">
      <div id="editor-host" data-initial-buffer="${escHtml(opts.defaultBuffer)}" data-default-buffer="${escHtml(opts.defaultBuffer)}" data-csrf-token="${escHtml(opts.csrfToken)}">
        <pre id="editor-fallback">${escHtml(opts.defaultBuffer)}</pre>
      </div>
    </div>

    <div class="controls">
      <div class="field">
        <label for="sync">Sync</label>
        <select id="sync">
          <option value="manual">Manual</option>
          <option value="lom">Live (LOM)</option>
          <option value="midi-clock">MIDI Clock</option>
          <option value="link">Ableton Link</option>
        </select>
      </div>
      <div class="field"><label for="bpm">BPM</label><input id="bpm" type="number" min="20" max="300" step="0.1" value="120"></div>
      <div class="field"><label for="cycle">Cycle (beats)</label><input id="cycle" type="number" min="0.25" max="64" step="0.25" value="4"></div>
      <div class="field"><label for="bakeCycles">Bake (cycles)</label><input id="bakeCycles" type="number" min="1" max="8" step="1" value="4"></div>
      <div class="spacer"></div>
      <button id="evalBlock" class="primary">Eval block <kbd>⌘↵</kbd></button>
      <button id="evalAll">Eval all <kbd>⇧⌘↵</kbd></button>
      <button id="stop" class="danger">Hush <kbd>⌘.</kbd></button>
    </div>

    <div class="log-panel" id="logPanel" role="region" aria-label="Logs">
      <div class="log-header" id="logHeader">
        <span class="log-toggle" id="logToggle">▸</span>
        <span class="log-title">Logs</span>
        <span class="log-badge" id="logBadge">0</span>
        <div class="log-actions">
          <button id="logClear" type="button">Clear</button>
        </div>
      </div>
      <div class="log-filters" id="logFilters"></div>
      <div class="log-body" id="logBody" role="log" aria-live="polite" aria-relevant="additions">
        <div class="log-empty" id="logEmpty">No log entries yet.</div>
      </div>
    </div>

    <div class="lidal-cheat" id="cheatsheet" role="region" aria-label="Quick reference">
      <div class="lidal-cheat-strip" id="cheatsheetStrip" role="button" tabindex="0" aria-controls="cheatsheetBody" aria-expanded="false">
        <span class="lidal-cheat-chevron" aria-hidden="true">▸</span>
        <span class="lidal-cheat-strip-text">Cheat sheet</span>
        <span class="lidal-cheat-strip-hint">· <kbd>⌘?</kbd> for full reference · <kbd>⌘P</kbd> for command palette</span>
      </div>
      <div class="lidal-cheat-body" id="cheatsheetBody">
        <div class="row">
          <strong style="color:var(--fg-dim);">Orbits</strong>:
          <code>d1 $ p</code> … <code>d16 $ p</code> register on orbit/channel ·
          <code>hush</code> stop all ·
          <code>d2 silence</code> clear one orbit
        </div>
        <div class="row">
          <strong style="color:var(--fg-dim);">Shortcuts</strong>:
          <kbd>⌘↵</kbd> eval block ·
          <kbd>⇧⌘↵</kbd> eval all ·
          <kbd>⌘.</kbd> hush ·
          <kbd>⌘B</kbd> bake ·
          <kbd>⌘/</kbd> toggle comment ·
          <kbd>⌃Space</kbd> autocomplete ·
          <kbd>⌘?</kbd> help ·
          <kbd>⌘P</kbd> palette
        </div>
        <div class="row">
          <strong style="color:var(--fg-dim);">Mini-notation</strong>:
          <code>a b c</code> sequence ·
          <code>[a b]</code> subdivide ·
          <code>[a, b]</code> parallel-in-slot ·
          <code>&lt;a b c&gt;</code> alternate per cycle ·
          <code>{a b, c d}</code> polyrhythm ·
          <code>{a b c}%4</code> polymeter ·
          <code>a*N</code> repeat ·
          <code>~</code> rest ·
          <code>a _ _ b</code> elongate ·
          <code>bd(3,8)</code> / <code>bd(3,8,2)</code> euclid ·
          <code>a?</code> / <code>a?0.3</code> degrade ·
          <code>a@2 b</code> weighted slot ·
          <code>a ! b</code> / <code>a !*3 b</code> replicate ·
          <code>0 .. 7</code> range ·
          <code>a b | c d</code> random pick ·
          <code>c'maj</code> / <code>f#3'min7</code> chord ·
          drums: <code>bd sd hh oh cp rim cy ride tom1-3 cb</code>
        </div>
        <div class="row">
          <strong style="color:var(--fg-dim);">Drum mapping</strong>:
          <code>drumMap 1 "bd:36 sn:38 tom1:41"</code> per-orbit override ·
          <code>autoMap 1 "909 Kit"</code> introspect a Live track's Drum Rack ·
          right-click a MIDI clip → <strong>Lidal: Auto-map drums…</strong>
        </div>
        <div class="row">
          <strong style="color:var(--fg-dim);">Bake</strong>:
          <kbd>⌘B</kbd> capture the last N cycles of the orbits in the current block into MIDI clips (one track per orbit, clips stack in the next free slot)
        </div>
      </div>
    </div>
  </main>

  <script src="/editor-client.js" defer></script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
