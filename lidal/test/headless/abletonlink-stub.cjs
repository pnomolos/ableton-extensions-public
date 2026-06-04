// Throw on load so LinkSource.available() returns false in headless mode.
// That cascades into a clean "Link unavailable; falling back to manual"
// path inside extension.ts — no Link discovery sockets opened in CI.
throw new Error("abletonlink stubbed out for headless mode");
