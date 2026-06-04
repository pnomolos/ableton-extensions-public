// Shared esbuild factory for Ableton Extension Host extensions.
// Usage: require("../../scripts/build-extension")({ entryPoint, outfile, watch, production })

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// Read the running extension's package.json and return its arclightNativeDeps array (or []).
// These deps are excluded from the esbuild bundle (kept as runtime require()s) so the
// extension can load native .node binaries from a sibling node_modules tree at runtime.
function readNativeDeps() {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return Array.isArray(pkg.arclightNativeDeps) ? pkg.arclightNativeDeps : [];
}

// Polyfill banner for the Ableton Extension Host VM sandbox.
const EH_POLYFILL_BANNER = `
var _ehUrl=require("url"),_ehUtil=require("util"),_ehBuf=require("buffer"),_ehVm=require("vm"),_ehWeb=require("stream/web"),_ehPerf=require("perf_hooks");
if(typeof URL==="undefined")globalThis.URL=_ehUrl.URL;
if(typeof URLSearchParams==="undefined")globalThis.URLSearchParams=_ehUrl.URLSearchParams;
if(typeof TextEncoder==="undefined")globalThis.TextEncoder=_ehUtil.TextEncoder;
if(typeof TextDecoder==="undefined")globalThis.TextDecoder=_ehUtil.TextDecoder;
if(typeof atob==="undefined")globalThis.atob=_ehBuf.atob;
if(typeof btoa==="undefined")globalThis.btoa=_ehBuf.btoa;
if(typeof Request==="undefined")globalThis.Request=_ehVm.runInThisContext("Request");
if(typeof Response==="undefined")globalThis.Response=_ehVm.runInThisContext("Response");
if(typeof Headers==="undefined")globalThis.Headers=_ehVm.runInThisContext("Headers");
if(typeof ReadableStream==="undefined")globalThis.ReadableStream=_ehWeb.ReadableStream;
if(typeof WritableStream==="undefined")globalThis.WritableStream=_ehWeb.WritableStream;
if(typeof TransformStream==="undefined")globalThis.TransformStream=_ehWeb.TransformStream;
if(typeof setImmediate==="undefined")globalThis.setImmediate=function(cb){return setTimeout(cb,0)};
if(typeof clearImmediate==="undefined")globalThis.clearImmediate=clearTimeout;
if(typeof performance==="undefined")globalThis.performance=_ehPerf.performance;
`.trim();

/**
 * Build an Ableton Extension Host extension with shared config.
 * @param {{ entryPoint: string, outfile: string, watch: boolean, production: boolean }} options
 */
async function buildExtension({ entryPoint, outfile, watch, production }) {
  const nativeDeps = readNativeDeps();
  if (nativeDeps.length) {
    console.log(`[build-extension] externalizing native deps: ${nativeDeps.join(", ")}`);
  }
  const ctx = await esbuild.context({
    entryPoints: [entryPoint],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    define: { global: "globalThis" },
    banner: { js: EH_POLYFILL_BANNER },
    external: nativeDeps,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "warning",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

module.exports = buildExtension;
