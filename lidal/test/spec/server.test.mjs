// HTTP/SSE server tests — focuses on the security and reliability surfaces
// added by the [ED] agent:
//   - CSRF: Origin + per-launch token validation on POSTs (#1)
//   - Last-Event-ID replay on SSE reconnect (#10)
//   - Log monotonic id assignment (#9)
//   - Backpressure: writableNeedDrain drops non-critical events (#11)
//   - Two-tab divergence: editor-presence broadcasts on connect/disconnect (#33)
//   - Snippet idempotency wire format — orbit tag preserved on the wire (#12)
//   - Buffer rewrite helper: replaceDrumMapLineInBuffer (#12)
//
// We exercise the real `startServer` against a real http server on a random
// port so the validation logic, replay ring, and presence broadcasts run end
// to end. Each test owns its own server + clean shutdown.

import { describe, it, expect, beforeEach } from "vitest";
import * as http from "http";
import {
  startServer,
  generateCsrfToken,
  isAllowedOrigin,
  timingSafeEqual,
  parseQueryParam,
  validatePost,
} from "../../src/server.ts";
import {
  logAppend,
  logClear,
  logSnapshot,
  __resetLogIdForTests,
} from "../../src/log.ts";
import { replaceDrumMapLineInBuffer } from "../../src/extension.ts";

// Each test grabs a fresh port (random ephemeral) to avoid stepping on stray
// state between runs.
async function freshPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer().listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.once("error", reject);
  });
}

function nullCallbacks() {
  return {
    onEval: () => ({}),
    onStop: () => {},
    onSetSync: () => ({ ok: true }),
    onBake: () => ({ ok: true, message: "" }),
    getStatus: () => ({
      running: false, buffer: "", bpm: 120, cycleBeats: 4, lastError: null,
      orbits: [], controlOrbits: [], cycleN: 0,
      syncMode: "manual", syncError: null, linkPeers: 0, linkIsPlaying: null,
      linkAvailable: false,
    }),
    getLogSnapshot: () => logSnapshot(),
    onClearLog: () => logClear(),
    onBufferSync: () => {},
  };
}

async function startTest(opts = {}) {
  const port = await freshPort();
  const token = opts.token ?? "test-token-1234567890abcdef";
  const handle = await startServer(port, nullCallbacks(), () => "<html></html>", { csrfToken: token });
  return { port, token, handle };
}

// Minimal POST helper that does NOT use fetch (so we have full control over
// Origin / X-Lidal-Token headers — node's fetch synthesises Origin for us).
function postRaw(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ?? "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

// ── CSRF helpers (pure functions) ────────────────────────────────────────

describe("server CSRF helpers", () => {
  it("isAllowedOrigin accepts both localhost and 127.0.0.1 on the listen port", () => {
    expect(isAllowedOrigin("http://localhost:7654", 7654)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:7654", 7654)).toBe(true);
  });
  it("isAllowedOrigin rejects mismatched port", () => {
    expect(isAllowedOrigin("http://localhost:8080", 7654)).toBe(false);
  });
  it("isAllowedOrigin rejects null/missing/cross-origin", () => {
    expect(isAllowedOrigin(undefined, 7654)).toBe(false);
    expect(isAllowedOrigin("", 7654)).toBe(false);
    expect(isAllowedOrigin("https://evil.example", 7654)).toBe(false);
    expect(isAllowedOrigin("null", 7654)).toBe(false);
    expect(isAllowedOrigin("http://localhost:7654.evil.com", 7654)).toBe(false);
  });

  it("timingSafeEqual matches identical strings only", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("parseQueryParam pulls a single key", () => {
    expect(parseQueryParam("/api/events?t=abc", "t")).toBe("abc");
    expect(parseQueryParam("/api/events?x=1&t=abc&y=2", "t")).toBe("abc");
    expect(parseQueryParam("/api/events", "t")).toBeNull();
    expect(parseQueryParam("/api/events?t=a%2Bb", "t")).toBe("a+b");
  });

  it("validatePost requires both Origin and matching token", () => {
    const ok = { headers: { origin: "http://localhost:7654", "x-lidal-token": "tok" } };
    expect(validatePost(ok, 7654, "tok")).toBe(true);

    // Wrong origin
    expect(validatePost({ headers: { origin: "http://evil.com", "x-lidal-token": "tok" } }, 7654, "tok")).toBe(false);
    // Missing origin
    expect(validatePost({ headers: { "x-lidal-token": "tok" } }, 7654, "tok")).toBe(false);
    // Wrong token
    expect(validatePost({ headers: { origin: "http://localhost:7654", "x-lidal-token": "bad" } }, 7654, "tok")).toBe(false);
    // Missing token
    expect(validatePost({ headers: { origin: "http://localhost:7654" } }, 7654, "tok")).toBe(false);
  });

  it("generateCsrfToken yields 64-char hex strings", () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    // Two consecutive calls are not equal.
    expect(generateCsrfToken()).not.toBe(t);
  });
});

// ── End-to-end POST rejection ─────────────────────────────────────────────

describe("server POST validation (end-to-end)", () => {
  it("rejects /api/eval without Origin or token (CSRF blocked)", async () => {
    const { port, handle } = await startTest();
    try {
      const r = await postRaw(port, "/api/eval", {}, JSON.stringify({ code: "", buffer: "" }));
      expect(r.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it("rejects /api/eval with bad origin", async () => {
    const { port, token, handle } = await startTest();
    try {
      const r = await postRaw(port, "/api/eval",
        { origin: "https://evil.example", "x-lidal-token": token },
        JSON.stringify({ code: "", buffer: "", bpm: 120, cycleBeats: 4 }),
      );
      expect(r.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it("rejects /api/eval with wrong token even from localhost", async () => {
    const { port, handle } = await startTest();
    try {
      const r = await postRaw(port, "/api/eval",
        { origin: `http://localhost:${port}`, "x-lidal-token": "wrong" },
        JSON.stringify({ code: "", buffer: "", bpm: 120, cycleBeats: 4 }),
      );
      expect(r.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it("accepts /api/eval with matching Origin and token", async () => {
    const { port, token, handle } = await startTest();
    try {
      const r = await postRaw(port, "/api/eval",
        { origin: `http://localhost:${port}`, "x-lidal-token": token },
        JSON.stringify({ code: "", buffer: "", bpm: 120, cycleBeats: 4 }),
      );
      expect(r.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("rejects /api/stop without token (was previously open)", async () => {
    const { port, handle } = await startTest();
    try {
      const r = await postRaw(port, "/api/stop", { origin: `http://localhost:${port}` }, "");
      expect(r.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});

// ── SSE token gating ──────────────────────────────────────────────────────

function getSse(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path,
      headers: headers ?? {},
    }, (res) => {
      // Don't read the body — just give the caller the status + the request
      // so they can abort it.
      resolve({ status: res.statusCode, res, req });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("server SSE /api/events token gating", () => {
  it("rejects missing token with 403", async () => {
    const { port, handle } = await startTest();
    try {
      const r = await getSse(port, "/api/events");
      expect(r.status).toBe(403);
      r.req.destroy();
    } finally {
      await handle.close();
    }
  });

  it("rejects mismatched token with 403", async () => {
    const { port, handle } = await startTest();
    try {
      const r = await getSse(port, `/api/events?t=wrong`);
      expect(r.status).toBe(403);
      r.req.destroy();
    } finally {
      await handle.close();
    }
  });

  it("accepts matching token", async () => {
    const { port, token, handle } = await startTest();
    try {
      const r = await getSse(port, `/api/events?t=${token}`);
      expect(r.status).toBe(200);
      r.req.destroy();
    } finally {
      await handle.close();
    }
  });
});

// ── SSE replay (Last-Event-ID) ────────────────────────────────────────────

// Helper that opens an SSE connection and returns a promise that resolves once
// either (a) `predicate` returns true for a parsed event payload, or (b) the
// timeout expires (returning whatever was collected).
function collectEvents(port, path, headers, opts = {}) {
  const timeout = opts.timeout ?? 800;
  const stopAt = opts.stopAt;
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path,
      headers: headers ?? {},
    }, (res) => {
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ status: res.statusCode, events });
      }, timeout);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        // Parse "name: ...\nid: ...\ndata: ...\n\n" frames.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = {};
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) ev.name = line.slice(7);
            else if (line.startsWith("id: ")) ev.id = parseInt(line.slice(4), 10);
            else if (line.startsWith("data: ")) ev.data = line.slice(6);
          }
          if (ev.name) events.push(ev);
          if (stopAt && stopAt(events)) {
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode, events });
            return;
          }
        }
      });
    });
    req.on("error", () => resolve({ status: 0, events }));
    req.end();
  });
}

describe("server SSE replay on Last-Event-ID", () => {
  beforeEach(() => { logClear(); __resetLogIdForTests(); });

  it("emits monotonic ids on every event", async () => {
    const { port, token, handle } = await startTest();
    try {
      // Open the SSE connection first, then fire a snippet so the client
      // sees it. (Pre-connect broadcasts only show up on Last-Event-ID
      // reconnect — that's exercised in the next test.)
      const collector = collectEvents(port, `/api/events?t=${token}`, {}, {
        stopAt: (ev) => ev.some((e) => e.name === "snippet"),
      });
      // Give the connection a moment to land before broadcasting.
      await new Promise((r) => setTimeout(r, 30));
      handle.broadcastSnippet({ snippet: 'drumMap 1 "bd:36"', orbit: 1, kind: "drumMap" });
      const r = await collector;
      const idsSeen = r.events.filter((e) => Number.isFinite(e.id)).map((e) => e.id);
      for (let i = 1; i < idsSeen.length; i++) {
        expect(idsSeen[i]).toBeGreaterThan(idsSeen[i - 1]);
      }
      expect(r.events.some((e) => e.name === "snippet")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("replays missed events when client reconnects with Last-Event-ID", async () => {
    const { port, token, handle } = await startTest();
    try {
      // Phase 1: client connects, learns the initial event id range, then
      // disconnects (simulates a tab refresh).
      const first = await collectEvents(port, `/api/events?t=${token}`, {}, {
        stopAt: (ev) => ev.length >= 2, // status + log-snapshot
      });
      const lastSeenId = Math.max(...first.events.map((e) => e.id ?? 0));
      expect(lastSeenId).toBeGreaterThan(0);

      // Phase 2: while no client is connected, fire a critical event that
      // should land in the replay ring.
      handle.broadcastSnippet({ snippet: 'drumMap 2 "bd:36"', orbit: 2, kind: "drumMap" });

      // Phase 3: reconnect with Last-Event-ID set to lastSeenId. Server
      // should replay the snippet we missed.
      const second = await collectEvents(port, `/api/events?t=${token}`,
        { "last-event-id": String(lastSeenId) },
        { stopAt: (ev) => ev.some((e) => e.name === "snippet") },
      );
      const snippet = second.events.find((e) => e.name === "snippet");
      expect(snippet).toBeDefined();
      expect(snippet.data).toContain("drumMap 2");
      expect(snippet.id).toBeGreaterThan(lastSeenId);
    } finally {
      await handle.close();
    }
  });
});

// ── EADDRINUSE recovery (#34) ─────────────────────────────────────────────

describe("server EADDRINUSE rejection", () => {
  it("rejects with a clear message when the port is already taken", async () => {
    // Grab a port and hold it open ourselves, then ask startServer to bind
    // the same port.
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const occupied = blocker.address().port;
    try {
      let rejected = null;
      try {
        await startServer(occupied, nullCallbacks(), () => "", { csrfToken: "x" });
      } catch (e) {
        rejected = e;
      }
      expect(rejected).not.toBeNull();
      expect(String(rejected.message)).toMatch(/already in use/i);
      expect(String(rejected.message)).toContain(String(occupied));
    } finally {
      await new Promise((resolve) => blocker.close(() => resolve()));
    }
  });
});

// ── Editor presence (two-tab divergence) ──────────────────────────────────

describe("server editor-presence broadcasts", () => {
  it("broadcasts a presence event with the connected-client count on connect", async () => {
    const { port, token, handle } = await startTest();
    try {
      const r = await collectEvents(port, `/api/events?t=${token}`, {}, {
        stopAt: (ev) => ev.some((e) => e.name === "editor-presence"),
      });
      const presence = r.events.find((e) => e.name === "editor-presence");
      expect(presence).toBeDefined();
      const data = JSON.parse(presence.data);
      expect(data.clientCount).toBe(1);
    } finally {
      await handle.close();
    }
  });
});

// ── Log monotonic ids ─────────────────────────────────────────────────────

describe("log entries carry monotonic ids", () => {
  beforeEach(() => { logClear(); __resetLogIdForTests(); });

  it("logAppend assigns strictly increasing ids", () => {
    logAppend({ ts: 1, level: "info", source: "system", message: "a" });
    logAppend({ ts: 2, level: "info", source: "system", message: "b" });
    logAppend({ ts: 3, level: "info", source: "system", message: "c" });
    const snap = logSnapshot();
    expect(snap.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(snap[0].message).toBe("a");
  });

  it("ids keep monotonically advancing even after logClear()", () => {
    logAppend({ ts: 1, level: "info", source: "system", message: "a" });
    const firstId = logSnapshot()[0].id;
    logClear();
    logAppend({ ts: 2, level: "info", source: "system", message: "b" });
    const nextId = logSnapshot()[0].id;
    expect(nextId).toBeGreaterThan(firstId);
  });
});

// ── Buffer rewrite (snippet idempotency) ──────────────────────────────────

describe("replaceDrumMapLineInBuffer", () => {
  it("prepends when no drumMap line exists for that orbit", () => {
    const out = replaceDrumMapLineInBuffer('d1 $ s "bd"', 1, 'drumMap 1 "bd:36"');
    expect(out).toBe('drumMap 1 "bd:36"\n\nd1 $ s "bd"');
  });

  it("replaces an existing drumMap line for the same orbit in place", () => {
    const buf = 'drumMap 1 "old:1"\n\nd1 $ s "bd"';
    const out = replaceDrumMapLineInBuffer(buf, 1, 'drumMap 1 "new:2"');
    expect(out).toBe('drumMap 1 "new:2"\n\nd1 $ s "bd"');
  });

  it("does not touch a different orbit's drumMap line", () => {
    const buf = 'drumMap 1 "kept"\n\ndrumMap 2 "replace-me"\n\nd1 $ s "bd"';
    const out = replaceDrumMapLineInBuffer(buf, 2, 'drumMap 2 "replaced"');
    expect(out).toBe('drumMap 1 "kept"\n\ndrumMap 2 "replaced"\n\nd1 $ s "bd"');
  });

  it("handles indented drumMap lines", () => {
    const buf = '  drumMap 3 "old"\n\nd1 $ s "bd"';
    const out = replaceDrumMapLineInBuffer(buf, 3, 'drumMap 3 "new"');
    expect(out).toBe('drumMap 3 "new"\n\nd1 $ s "bd"');
  });

  it("returns the snippet alone when buffer is empty", () => {
    const out = replaceDrumMapLineInBuffer("", 1, 'drumMap 1 "bd:36"');
    expect(out).toBe('drumMap 1 "bd:36"');
  });

  it("is idempotent across repeated runs", () => {
    let buf = '';
    buf = replaceDrumMapLineInBuffer(buf, 1, 'drumMap 1 "v1"');
    buf = replaceDrumMapLineInBuffer(buf, 1, 'drumMap 1 "v2"');
    buf = replaceDrumMapLineInBuffer(buf, 1, 'drumMap 1 "v3"');
    // Only one drumMap line ever exists for that orbit.
    const matches = buf.match(/^drumMap 1\b/mg) ?? [];
    expect(matches.length).toBe(1);
    expect(buf).toContain('drumMap 1 "v3"');
  });
});
