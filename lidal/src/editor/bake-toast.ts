// A small ephemeral toast shown after a successful bake. Lives at the bottom
// of the editor; ARIA role=status so screen readers announce the success.
// Failures are NOT shown here — they remain in the log panel where the user
// can investigate detail.

interface ToastHandle {
  /** The mounted toast element. Append to a stable host (e.g. <main>). */
  el: HTMLElement;
  /** Show a success toast with the given message. Cancels any pending hide. */
  show(message: string): void;
  /** Hide immediately. */
  hide(): void;
  /** Detach from DOM. */
  destroy(): void;
}

const TOAST_VISIBLE_MS = 3000;

/**
 * Create the toast element. The caller appends `el` somewhere (we recommend
 * <main> so it sits above the log panel without affecting layout).
 */
export function createBakeToast(): ToastHandle {
  const el = document.createElement("div");
  el.id = "feedback-bake-toast";
  el.className = "lidal-feedback-bake-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");

  let hideTimer: number | null = null;

  function show(message: string): void {
    el.textContent = message;
    el.classList.add("visible");
    if (hideTimer != null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      el.classList.remove("visible");
      hideTimer = null;
    }, TOAST_VISIBLE_MS);
  }

  function hide(): void {
    el.classList.remove("visible");
    if (hideTimer != null) { window.clearTimeout(hideTimer); hideTimer = null; }
  }

  return {
    el,
    show,
    hide,
    destroy() {
      hide();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

/**
 * Parse the bake message and extract the list of orbit names. The backend
 * formats success as something like:
 *   "✓ baked → lidal_d1 (clip 0), lidal_d3 (clip 0) (skipped d4)"
 *
 * We strip the leading "✓ baked →" sentinel, drop the parenthetical clip
 * indices, drop "(skipped …)" hints, and trim. If parsing fails we just hand
 * the message back as-is — the toast still works, it just isn't pretty.
 */
export function summarizeBakeMessage(message: string, cycles: number | undefined): string {
  // Try to pull the comma-separated track list from the canonical format.
  const m = /baked\s*→\s*(.+)$/i.exec(message);
  let body = m ? m[1] : message;
  // Drop "(skipped …)" trailing clause(s).
  body = body.replace(/\(skipped[^)]*\)\s*$/g, "").trim();
  // Strip "(clip N)" parenthetical from each track name.
  const tracks = body
    .split(",")
    .map((s) => s.replace(/\s*\(clip[^)]*\)\s*$/i, "").trim())
    .filter(Boolean);
  // Map "lidal_d1" / "lidal_s2" / "lidal_c3" → "d1" / "s2" / "c3" for compact
  // display. Anything else passes through unchanged (e.g. a timestamped
  // fallback track name from the bake-overflow path).
  const friendly = tracks.map((t) => {
    const tm = /^lidal_([dsc]\d+)$/i.exec(t);
    return tm ? tm[1].toLowerCase() : t;
  });
  const list = friendly.length > 0 ? friendly.join(", ") : "?";
  if (cycles && cycles > 0) {
    return `Baked ${cycles} cycle${cycles === 1 ? "" : "s"} → ${list}`;
  }
  return `Baked → ${list}`;
}
