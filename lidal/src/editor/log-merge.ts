// Pure helper: merge a fresh server log snapshot with the entries the editor
// already has, deduping by id (or by ts+source+message for legacy entries
// without ids). Result is sorted by id (then ts) ascending and trimmed to the
// caller's max-rows cap.
//
// Extracted into its own module so vitest can exercise it in the `node`
// environment without pulling in CodeMirror — client.ts otherwise imports
// CM6 at module load.
//
// Fixes TOFIX #9: the previous code full-replaced on snapshot, which wiped
// already-shown entries from the user's view whenever the server's
// ring-buffer wrapped during an SSE outage.

export interface LogEntryLike {
  ts: number;
  level: string;
  source: string;
  message: string;
  id?: number;
  detail?: string;
}

export function mergeLogSnapshot<T extends LogEntryLike>(
  existing: T[],
  incoming: T[],
  maxRows: number,
): T[] {
  const byKey = new Map<string, T>();
  const keyOf = (e: T): string =>
    typeof e.id === "number" ? `id:${e.id}` : `legacy:${e.ts}|${e.source}|${e.message}`;
  for (const e of existing) byKey.set(keyOf(e), e);
  for (const e of incoming) byKey.set(keyOf(e), e);
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    if (typeof a.id === "number" && typeof b.id === "number") return a.id - b.id;
    return a.ts - b.ts;
  });
  if (merged.length > maxRows) return merged.slice(-maxRows);
  return merged;
}
