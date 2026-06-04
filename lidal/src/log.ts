// Ring-buffered log of user-relevant events. Surfaced via the editor's log
// panel (SSE-pushed) so the user has scrollable history beyond the pill's
// single-message capacity. Independent of `console.*` — that remains the
// developer's safety net in the Extension Host log.

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogSource = "eval" | "pattern" | "sync" | "bake" | "automap" | "system" | "lifecycle";

export interface LogEntry {
  ts: number;          // Date.now()
  level: LogLevel;
  source: LogSource;
  message: string;
  // Monotonic per-process id. Lets the editor merge an SSE log-snapshot with
  // entries it already has (rather than full-replacing) so a ring-buffer
  // wraparound during the client's disconnect window doesn't wipe history
  // the user already saw. Persists across reconnects within a single launch.
  id?: number;
  // Optional multi-line text (e.g. stack trace). Trimmed to MAX_DETAIL_CHARS
  // on insert so the buffer can't blow up from a thousand-frame stack.
  detail?: string;
}

const MAX_ENTRIES = 200;
const MAX_DETAIL_CHARS = 500;

const buffer: LogEntry[] = [];
type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();
// Monotonic id counter. Never resets on logClear() — clearing wipes the ring
// but the next-issued id remains strictly greater than anything the client
// has seen, so a merge after Clear simply replaces the cleared range cleanly.
let nextId = 1;

export function logAppend(entry: LogEntry): void {
  const trimmed: LogEntry = {
    id: nextId++,
    ts: entry.ts,
    level: entry.level,
    source: entry.source,
    message: entry.message,
  };
  if (entry.detail) {
    trimmed.detail = entry.detail.length > MAX_DETAIL_CHARS
      ? entry.detail.slice(0, MAX_DETAIL_CHARS) + "…"
      : entry.detail;
  }
  buffer.push(trimmed);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  for (const fn of listeners) {
    try { fn(trimmed); } catch { /* never let a listener kill logging */ }
  }
}

export function logSnapshot(): LogEntry[] {
  return buffer.slice();
}

export function logClear(): void {
  buffer.length = 0;
}

// Test-only: reset the monotonic counter so consecutive vitest runs don't
// accumulate ids. Production never calls this.
export function __resetLogIdForTests(): void {
  nextId = 1;
}

export function onLogAppend(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Helper: extract message + first 2-3 stack frames from a thrown value.
// vm runtime errors have a usable `stack` — fall back to message-only otherwise.
export function errorDetail(e: unknown): string | undefined {
  if (e instanceof Error && typeof e.stack === "string") {
    const lines = e.stack.split("\n");
    // Stack usually starts with "<Name>: <msg>" then frames — keep first 4 lines.
    return lines.slice(0, 4).join("\n");
  }
  return undefined;
}
