import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import type { LogEntry } from "./log.js";

export type SyncMode = "manual" | "lom" | "midi-clock" | "link";

export interface ServerStatus {
  running: boolean;
  buffer: string;
  bpm: number;
  cycleBeats: number;
  lastError: string | null;
  orbits: number[];
  controlOrbits: number[];
  cycleN: number;
  syncMode: SyncMode;
  syncError: string | null;
  linkPeers: number;
  linkIsPlaying: boolean | null;
  linkAvailable: boolean;
  // Most recent bake outcome. The editor renders the message in its status pill
  // when `ts` changes; bake itself is fire-and-forget, so this is how async
  // SDK-side success/failure surfaces to the user.
  lastBake?: { ts: number; ok: boolean; message: string };
}

// Per-orbit live activity. Emitted at most ~10 Hz per orbit; consumers render a
// small "what's playing now" widget. `lastValue` is a string for note orbits
// (resolved name like "C4" or drum alias "bd") and an int 0..127 for ctrl.
// `active` flips false when the scheduler stops firing for that orbit (clear /
// hush). Channel is 1..16.
export interface OrbitMonitorEvent {
  type: "note" | "ctrl";
  orbit: string;       // "d1".."d16" or "c1".."c8"
  channel: number;
  lastValue: string | number;
  lastCycle: number;
  active: boolean;
}

// Snapshot of sync state. Emitted on transport / mode / availability change,
// at most once per cycle when no event-driven change occurred. Editor renders
// in the status pill.
export interface SyncStatusEvent {
  mode: SyncMode;
  bpm: number;
  quantum: number;
  linkAvailable: boolean;
  linkError: string | null;
  peers: number | null;  // null when not in Link mode
}

export interface BakeBody {
  orbits: number[];          // d-style orbit numbers (1..16) — note + drum portTypes
  controlOrbits: number[];   // c-style orbit numbers (1..8) — currently not bakeable
  cycles: number;            // 1..8
}

export interface BakeResult {
  ok: boolean;
  message: string;
  // Track names that were created or updated. Surfaced for editor messages.
  tracks?: string[];
  // Machine-readable reason on failure: "no-orbits" | "cc-only" | "no-history" | "sdk".
  reason?: string;
}

export interface EvalBody {
  code: string;       // the fragment to evaluate (block under cursor or whole buffer)
  buffer: string;     // the entire buffer text — server stores it for SSE rebroadcast
  bpm: number;
  cycleBeats: number;
}

// Snippet broadcast payload. `orbit` is optional — when set, the client should
// replace any existing `drumMap N` line for that orbit instead of prepending,
// keeping the buffer idempotent across repeated auto-map runs.
export interface SnippetEvent {
  snippet: string;
  orbit?: number;
  kind?: "drumMap" | "raw";
}

export interface ServerCallbacks {
  onEval: (body: EvalBody) => { error?: string };
  onStop: () => void;
  onSetSync: (mode: SyncMode) => { ok: boolean; error?: string };
  onBake: (body: BakeBody) => BakeResult;
  getStatus: () => ServerStatus;
  // Snapshot of the current log ring buffer — pushed to each new SSE client
  // so the panel can reconstruct history on (re)connect.
  getLogSnapshot: () => LogEntry[];
  // Wipe the ring buffer. Called by POST /api/log/clear; the server then
  // re-broadcasts an empty snapshot so every editor reflects the change.
  onClearLog: () => void;
  // Debounced editor → server buffer sync. Lets the server keep its in-memory
  // `buffer` aligned with the user's live edits (so snippet-prepend and
  // restore-after-reload reflect unsaved typing), without waiting for the
  // next eval.
  onBufferSync: (text: string) => void;
}

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
  // Push a fresh status to all SSE clients. Used by the extension after async
  // SDK writes complete so the editor can render the bake result.
  broadcastStatus: () => void;
  // Push a one-off code snippet to be prepended to the editor buffer. Used by
  // the auto-map context-menu action to surface the generated `drumMap` line.
  // The optional `orbit` lets the client treat the snippet as a per-orbit
  // replacement (e.g. only one `drumMap 3 "..."` ever exists in the buffer).
  broadcastSnippet: (event: SnippetEvent | string) => void;
  // Push a single newly-appended log entry to every connected editor.
  broadcastLog: (entry: LogEntry) => void;
  // Push the full current log buffer (used on clear).
  broadcastLogSnapshot: () => void;
  // Push a single orbit's current state. Caller is expected to throttle so we
  // don't flood the SSE channel with one event per scheduled note.
  broadcastOrbitMonitor: (event: OrbitMonitorEvent) => void;
  // Push a sync-state snapshot. Caller decides cadence (transport change /
  // per-cycle fallback).
  broadcastSyncStatus: (event: SyncStatusEvent) => void;
  // True when at least one SSE client is connected. Lets the caller short-
  // circuit work (e.g. building monitor payloads) when nobody's listening.
  hasClients: () => boolean;
  // The per-launch CSRF token. Exposed so the page renderer can inject it
  // into the editor HTML; not part of the protocol surface beyond that.
  csrfToken: string;
}

const MAX_BODY_BYTES = 1024 * 1024;  // 1 MB — typical buffer is a few KB

// Cap on the per-launch SSE replay ring. Picked to be "small but enough to
// cover a developer-tools reconnect blip" — a few seconds of orbit-monitor
// chatter plus all snippet/sync-status emissions in that window.
const SSE_REPLAY_RING_MAX = 100;

// Per-client buffer for critical events under backpressure (snippet, log,
// sync-status). When the client's write buffer is saturated we hold up to
// this many events before forcibly disconnecting; non-critical events
// (orbit-monitor) are dropped without buffering. Keeps a slow client from
// growing the extension's heap unboundedly while still surviving a brief
// stall.
const SSE_CRITICAL_BUFFER_MAX = 64;

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let total = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      buf += chunk;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}") as T); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// CSRF defense (TOFIX #1):
//
// Validate the Origin header on every state-changing POST against the actual
// host:port we listen on. We accept both `localhost` and `127.0.0.1` because
// the page renderer's "open browser" hand-off can land on either depending on
// the user's browser and OS. A missing Origin is also rejected — the editor
// always sets one (it's same-origin to the server), so its absence means a
// non-browser caller, which we don't trust.
//
// Defense in depth: the CSRF token check below ALSO has to pass. Origin alone
// isn't enough — null-origin contexts (file://, sandboxed iframes) bypass it.
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  return allowed.includes(origin);
}

// Type for an SSE client; we attach the buffer + a per-client "needsDrain"
// flag so the broadcasters can apply backpressure without per-call work.
interface SseClient {
  res: ServerResponse;
  // Pending events that survived the writableNeedDrain check; flushed on
  // 'drain'. Critical-only — orbit-monitor is dropped under pressure.
  queued: { id: string; payload: string }[];
  // True once we've decided to terminate this client (queued > threshold).
  doomed: boolean;
}

export async function startServer(
  port: number,
  callbacks: ServerCallbacks,
  pageHtml: () => string,
  opts?: { csrfToken?: string },
): Promise<ServerHandle> {
  const sseClients = new Set<SseClient>();
  // Per-launch CSRF token. Provided by the caller (extension.ts) so it can
  // also inject it into the page HTML; we fall back to a freshly-generated
  // one if the caller didn't pass anything (e.g. unit tests).
  const csrfToken = opts?.csrfToken ?? generateCsrfToken();

  // SSE replay ring (TOFIX #10). Stores recent events that we'd want to
  // re-deliver on Last-Event-ID reconnect. Critical events (snippet,
  // sync-status, status) always go in; orbit-monitor goes in but is allowed
  // to age out fastest since the next live monitor sample subsumes it.
  let nextEventId = 1;
  const replayRing: { id: number; payload: string; kind: string }[] = [];

  function isCritical(kind: string): boolean {
    return kind === "snippet" || kind === "log" || kind === "log-snapshot"
      || kind === "sync-status" || kind === "status" || kind === "editor-presence";
  }

  // [ED-agent fix #33] Broadcast the current SSE client count so each editor
  // tab can tell whether it's alone or sharing the session. The second-and-
  // later tabs warn the user and disable autosave to avoid the
  // "last-debounced-writer-wins" divergence the previous code suffered.
  function broadcastPresence(): void {
    broadcastEvent("editor-presence", JSON.stringify({ clientCount: sseClients.size }));
  }

  function writeTo(client: SseClient, payload: string, kind: string): void {
    if (client.doomed) return;
    const { res } = client;
    if (res.writableEnded || res.writableNeedDrain) {
      // Backpressure: client is paused (background tab, stalled devtools, or
      // the connection itself). For non-critical events we drop silently — the
      // next live event will subsume them. For critical events we buffer up
      // to SSE_CRITICAL_BUFFER_MAX; on overflow we tear the client down.
      if (!isCritical(kind)) return;
      if (client.queued.length >= SSE_CRITICAL_BUFFER_MAX) {
        client.doomed = true;
        sseClients.delete(client);
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      client.queued.push({ id: kind, payload });
      return;
    }
    try {
      const ok = res.write(payload);
      if (!ok && isCritical(kind)) {
        // The write succeeded but the socket buffer is now saturated; we'll
        // start queueing on the next event. Nothing to do here — node will
        // fire 'drain' when the kernel buffer empties.
      }
    } catch {
      sseClients.delete(client);
    }
  }

  function broadcastEvent(kind: string, dataJson: string): void {
    // Critical events go into the replay ring even when no client is
    // connected — a client reconnecting immediately afterwards should still
    // see them. Non-critical (orbit-monitor) events skip the ring entirely
    // when nobody's listening, preserving the "no clients → no work"
    // optimisation.
    if (sseClients.size === 0 && !isCritical(kind)) return;
    const id = nextEventId++;
    const payload = `event: ${kind}\nid: ${id}\ndata: ${dataJson}\n\n`;
    replayRing.push({ id, payload, kind });
    if (replayRing.length > SSE_REPLAY_RING_MAX) replayRing.shift();
    for (const client of sseClients) {
      writeTo(client, payload, kind);
    }
  }

  function broadcastStatus(): void {
    const status = callbacks.getStatus();
    broadcastEvent("status", JSON.stringify(status));
  }

  function broadcastSnippet(event: SnippetEvent | string): void {
    const payload: SnippetEvent = typeof event === "string"
      ? { snippet: event }
      : event;
    broadcastEvent("snippet", JSON.stringify(payload));
  }

  function broadcastLog(entry: LogEntry): void {
    broadcastEvent("log", JSON.stringify(entry));
  }

  function broadcastLogSnapshot(): void {
    const snap = callbacks.getLogSnapshot();
    broadcastEvent("log-snapshot", JSON.stringify(snap));
  }

  function broadcastOrbitMonitor(event: OrbitMonitorEvent): void {
    // Short-circuit when no clients attached — preserves the scheduler's
    // "skip per-tick payload construction" optimisation. (Preserve list.)
    if (sseClients.size === 0) return;
    broadcastEvent("orbit-monitor", JSON.stringify(event));
  }

  function broadcastSyncStatus(event: SyncStatusEvent): void {
    if (sseClients.size === 0) return;
    broadcastEvent("sync-status", JSON.stringify(event));
  }

  function hasClients(): boolean { return sseClients.size > 0; }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    // Intentionally NOT setting `access-control-allow-origin: *` here — the
    // previous wildcard let any web page POST to /api/eval and execute
    // arbitrary code in the vm sandbox. With same-origin XHR (which the
    // editor uses) we don't need CORS headers at all.

    try {
      if (method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pageHtml());
        return;
      }

      // Bundled CodeMirror 6 client. Lives next to the built extension at
      // <ext>/dist/editor-client.js. Found by walking up from this module's
      // path; cached on first hit so we don't stat per-request.
      if (method === "GET" && url === "/editor-client.js") {
        const bundle = resolveEditorClientBundle();
        if (bundle) {
          res.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "public, max-age=300",
          });
          res.end(bundle);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("editor-client.js not found — run `npm run build` in lidal/");
        return;
      }

      // SSE endpoint. Validates the per-launch token via query param (because
      // the EventSource API can't set custom headers) AND the Origin header
      // (defense in depth). We never wildcard CORS here — that would let any
      // origin EventSource our buffer.
      if (method === "GET" && (url === "/api/events" || url.startsWith("/api/events?"))) {
        // Token check. EventSource has no header API, so the page passes the
        // token via `?t=…`. Reject any mismatch immediately.
        const tokenFromQuery = parseQueryParam(url, "t");
        if (!tokenFromQuery || !timingSafeEqual(tokenFromQuery, csrfToken)) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("forbidden — bad/missing token");
          return;
        }
        // Origin check (when present — EventSource sometimes omits it).
        const origin = req.headers["origin"];
        if (typeof origin === "string" && origin && !isAllowedOrigin(origin, port)) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("forbidden — bad origin");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        const client: SseClient = { res, queued: [], doomed: false };
        // Replay any events the client missed if they sent Last-Event-ID.
        const lastEventIdRaw = req.headers["last-event-id"];
        const lastEventId = typeof lastEventIdRaw === "string"
          ? parseInt(lastEventIdRaw, 10)
          : NaN;
        if (Number.isFinite(lastEventId)) {
          // Replay everything strictly after Last-Event-ID. The ring is
          // small; iterating it for each reconnect is fine.
          for (const entry of replayRing) {
            if (entry.id > lastEventId) {
              try { res.write(entry.payload); } catch { /* closed */ }
            }
          }
        }
        // Initial state pushed AFTER replay so the client never sees a stale
        // status overwrite a fresher in-flight event from the ring.
        const statusId = nextEventId++;
        const statusPayload = `event: status\nid: ${statusId}\ndata: ${JSON.stringify(callbacks.getStatus())}\n\n`;
        try { res.write(statusPayload); } catch { /* closed */ }
        // Seed the new client with the current log buffer so its panel
        // renders history immediately, not just events that happen after
        // connect.
        const snapId = nextEventId++;
        const snapPayload = `event: log-snapshot\nid: ${snapId}\ndata: ${JSON.stringify(callbacks.getLogSnapshot())}\n\n`;
        try { res.write(snapPayload); } catch { /* closed */ }
        sseClients.add(client);
        // Tell everyone (including the new client) about the updated tab
        // count. Sent inside the response stream so the new tab sees its
        // own arrival count.
        broadcastPresence();
        // Drain handler: when the socket buffer empties, flush queued
        // critical events.
        res.on("drain", () => {
          while (client.queued.length > 0 && !res.writableNeedDrain && !client.doomed) {
            const entry = client.queued.shift();
            if (!entry) break;
            try { res.write(entry.payload); } catch { sseClients.delete(client); return; }
          }
        });
        const keepalive = setInterval(() => {
          try { res.write(": ka\n\n"); } catch { /* closed */ }
        }, 25_000);
        req.on("close", () => {
          clearInterval(keepalive);
          sseClients.delete(client);
          // Surviving tabs need to know their tab count dropped (so the
          // "second tab" warning can clear once they're alone again).
          broadcastPresence();
        });
        return;
      }

      // POST handlers — all of them must clear the CSRF / Origin gate.
      if (method === "POST") {
        if (!validatePost(req, port, csrfToken)) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden — bad origin or token" }));
          return;
        }
      }

      if (method === "POST" && url === "/api/eval") {
        const body = await readJsonBody<EvalBody>(req);
        const result = callbacks.onEval(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        broadcastStatus();
        return;
      }

      if (method === "POST" && url === "/api/sync") {
        const body = await readJsonBody<{ mode: SyncMode }>(req);
        const result = callbacks.onSetSync(body.mode);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        broadcastStatus();
        return;
      }

      if (method === "POST" && url === "/api/stop") {
        callbacks.onStop();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        broadcastStatus();
        return;
      }

      if (method === "POST" && url === "/api/bake") {
        const body = await readJsonBody<BakeBody>(req);
        const result = callbacks.onBake(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (method === "POST" && url === "/api/buffer") {
        const body = await readJsonBody<{ buffer?: unknown }>(req);
        const text = typeof body.buffer === "string" ? body.buffer : "";
        callbacks.onBufferSync(text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      if (method === "POST" && url === "/api/log/clear") {
        callbacks.onClearLog();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        // Re-broadcast so every connected editor wipes its panel in sync.
        broadcastLogSnapshot();
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });

  // EADDRINUSE recovery (TOFIX #34): surface the failure to the caller
  // instead of crashing the listen call silently. The caller (extension.ts)
  // can then skip the browser spawn and log a clear message.
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use — is another Lidal extension host running, or did a previous one not clean up?`));
        return;
      }
      reject(err);
    };
    server.once("error", onErr);
    server.listen(port, "127.0.0.1", () => { server.off("error", onErr); resolve(); });
  });

  return {
    port,
    close: () => new Promise((resolve) => {
      for (const client of sseClients) { try { client.res.end(); } catch { /* ignore */ } }
      sseClients.clear();
      server.close(() => resolve());
    }),
    broadcastStatus,
    broadcastSnippet,
    broadcastLog,
    broadcastLogSnapshot,
    broadcastOrbitMonitor,
    broadcastSyncStatus,
    hasClients,
    csrfToken,
  };
}

// Locate the bundled editor client. The extension bundle is at
// `<dist>/extension.js` and the client bundle is at `<dist>/editor-client.js`.
// We resolve once and cache, so the disk hit only happens on the first GET.
let cachedClientBundle: Buffer | null = null;

function resolveEditorClientBundle(): Buffer | null {
  if (cachedClientBundle) return cachedClientBundle;
  // Likely deployment paths (in priority order):
  //   <dirname(extension.js)>/editor-client.js                — production
  //   <dirname(extension.js)>/../dist/editor-client.js        — dev: built but
  //                                                            extension.js
  //                                                            wasn't moved
  //   process.cwd() + '/dist/editor-client.js'                — fallback when
  //                                                            __dirname is opaque
  const candidates: string[] = [];
  try {
    // In a CJS bundle, __dirname refers to the directory of the bundled
    // extension.js. We resolve relative to that.
    const here: string = __dirname;
    candidates.push(path.join(here, "editor-client.js"));
    candidates.push(path.join(here, "..", "dist", "editor-client.js"));
  } catch { /* not CJS — skip */ }
  candidates.push(path.join(process.cwd(), "dist", "editor-client.js"));
  for (const candidate of candidates) {
    try {
      const buf = fs.readFileSync(candidate);
      cachedClientBundle = buf;
      return buf;
    } catch { /* try next */ }
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Per-launch token generator. 32 bytes of randomness, hex-encoded — 64 chars,
// well above the bar for "guess-resistant" and small enough to fit in a query
// string. We avoid `crypto.randomUUID` to stay compatible with older Node and
// the VM sandbox; `crypto.randomBytes` is universally available.
export function generateCsrfToken(): string {
  // Lazy-require so test environments without `crypto` (unlikely on Node, but
  // defensive) don't fail at module load. In normal Node this is a no-op.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("crypto") as typeof import("crypto");
  return randomBytes(32).toString("hex");
}

// Constant-time string compare. Prevents a timing oracle leaking the token
// byte-by-byte; not strictly necessary at this scale but it's two lines.
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Parse a single query parameter from a URL path without `URL` (which the VM
// sandbox doesn't expose).
export function parseQueryParam(url: string, key: string): string | null {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return null;
  const qs = url.slice(qIdx + 1);
  for (const pair of qs.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? "" : pair.slice(eq + 1);
    if (decodeURIComponent(k) === key) {
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return null;
}

// Validate a state-changing POST. Both checks must pass:
//   - Origin header is present and matches our localhost listen address.
//   - x-lidal-token header matches the per-launch CSRF token.
//
// The token check is enforced unconditionally; Origin alone isn't sufficient
// because null-origin contexts (file://, sandboxed iframes) bypass it.
export function validatePost(req: IncomingMessage, port: number, csrfToken: string): boolean {
  const origin = req.headers["origin"];
  // Treat string-array case (HTTP/2 can split) and absent both as "no origin".
  const originStr = Array.isArray(origin) ? origin[0] : origin;
  if (!isAllowedOrigin(originStr, port)) return false;
  const token = req.headers["x-lidal-token"];
  const tokenStr = Array.isArray(token) ? token[0] : token;
  if (typeof tokenStr !== "string" || !timingSafeEqual(tokenStr, csrfToken)) return false;
  return true;
}
