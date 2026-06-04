const esbuild = require("esbuild");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const EH_POLYFILL_BANNER = `
var _ehUrl=require("url"),_ehUtil=require("util"),_ehBuf=require("buffer"),_ehVm=require("vm"),_ehWeb=require("stream/web");
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
`.trim();

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: "dist/extension.js",
    define: { global: "globalThis" },
    banner: { js: EH_POLYFILL_BANNER },
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
main().catch((e) => { console.error(e); process.exit(1); });
