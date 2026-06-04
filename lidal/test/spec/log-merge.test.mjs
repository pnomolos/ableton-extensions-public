// TOFIX #9: the editor used to full-replace its log entries on every SSE
// snapshot. If the server's 200-entry ring buffer wrapped during a
// reconnect, entries the client had already shown would vanish from view.
// mergeLogSnapshot is the dedup-and-union replacement.

import { describe, it, expect } from "vitest";
import { mergeLogSnapshot } from "../../src/editor/log-merge.ts";

const entry = (id, msg = "x", ts = id) => ({
  id, ts, level: "info", source: "system", message: msg,
});

describe("mergeLogSnapshot", () => {
  it("returns incoming when existing is empty", () => {
    const out = mergeLogSnapshot([], [entry(1), entry(2)], 100);
    expect(out.map((e) => e.id)).toEqual([1, 2]);
  });

  it("dedupes by id — same id never appears twice", () => {
    const a = [entry(1), entry(2), entry(3)];
    const b = [entry(2), entry(3), entry(4)];
    const out = mergeLogSnapshot(a, b, 100);
    expect(out.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("preserves entries the snapshot dropped (the wraparound case)", () => {
    // Client already has 1..5. Server's ring wrapped during the outage and
    // only kept 3..7. Merge should yield 1..7 (caller's cap permitting).
    const existing = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    const incoming = [entry(3), entry(4), entry(5), entry(6), entry(7)];
    const out = mergeLogSnapshot(existing, incoming, 100);
    expect(out.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("trims to maxRows when union exceeds the cap (keeps newest)", () => {
    const a = Array.from({ length: 150 }, (_, i) => entry(i + 1));
    const out = mergeLogSnapshot([], a, 100);
    expect(out.length).toBe(100);
    expect(out[0].id).toBe(51);
    expect(out[out.length - 1].id).toBe(150);
  });

  it("falls back to ts+source+message dedup for legacy entries without ids", () => {
    const a = [{ ts: 100, level: "info", source: "system", message: "hi" }];
    const b = [{ ts: 100, level: "info", source: "system", message: "hi" }];
    const out = mergeLogSnapshot(a, b, 100);
    expect(out.length).toBe(1);
  });

  it("incoming replaces existing on id collision (last wins)", () => {
    const a = [{ id: 7, ts: 1, level: "info", source: "system", message: "old" }];
    const b = [{ id: 7, ts: 1, level: "info", source: "system", message: "new" }];
    const out = mergeLogSnapshot(a, b, 100);
    expect(out[0].message).toBe("new");
  });
});
