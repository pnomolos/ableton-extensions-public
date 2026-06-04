import type { WebviewMessage } from "./types.js";

/**
 * Build a self-contained HTML data URL for use with the Extension SDK modal dialog.
 * The webview communicates back to the extension via:
 *   window.webkit.messageHandlers.live.postMessage({ name: "close_and_send", args: [JSON.stringify(msg)] })  (macOS)
 *   window.chrome.webview.postMessage({ name: "close_and_send", args: [JSON.stringify(msg)] })               (Windows)
 */
export function buildWebviewDataUrl(title: string, bodyHtml: string, scriptJs: string): string {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      background: #1a1a1a;
      color: #e0e0e0;
      overflow: hidden;
    }
    .header {
      background: #252525;
      border-bottom: 1px solid #333;
      padding: 10px 16px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #999;
    }
    .content { padding: 16px; }
    button {
      background: #333;
      border: 1px solid #444;
      color: #e0e0e0;
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: #444; }
    button.primary { background: #e05a00; border-color: #e05a00; color: white; }
    button.primary:hover { background: #f06a10; }
  </style>
</head>
<body>
  <div class="header">${escapeHtml(title)}</div>
  <div class="content">${bodyHtml}</div>
  <script>
function postMessage(msg) {
  const message = { name: "close_and_send", args: [JSON.stringify(msg)] };
  if (window.webkit?.messageHandlers?.live) {
    window.webkit.messageHandlers.live.postMessage(message);
  } else if (window.chrome?.webview) {
    window.chrome.webview.postMessage(message);
  }
}
${scriptJs}
  </script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build a minimal modal error dialog data URL. Used by extensions that need to
 * surface a one-shot "this can't proceed" message (no input expected). The OK
 * button uses the standard `close_and_send` protocol so the host dismisses the
 * modal when clicked.
 */
export function buildErrorDataUrl(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMsg = escapeHtml(message);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;font-size:13px;background:#1a1a1a;color:#e0e0e0;display:flex;flex-direction:column;height:100vh}
  .hdr{background:#252525;border-bottom:1px solid #333;padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#999}
  .body{flex:1;padding:20px 16px;display:flex;align-items:center;justify-content:center;text-align:center;color:#ccc}
  .ftr{padding:10px 16px;border-top:1px solid #2a2a2a;display:flex;justify-content:flex-end}
  button{background:#333;border:1px solid #444;color:#e0e0e0;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px}
  button:hover{background:#444}
</style></head>
<body><div class="hdr">${safeTitle}</div><div class="body">${safeMsg}</div>
<div class="ftr"><button onclick="(function(){var m={name:'close_and_send',args:['']};if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);})()">OK</button></div>
</body></html>`;
  return "data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf8").toString("base64");
}

export type { WebviewMessage };
