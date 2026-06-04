const buildExtension = require("../scripts/build-extension");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

buildExtension({ entryPoint: "src/extension.ts", outfile: "dist/extension.js", watch, production })
  .catch((e) => { console.error(e); process.exit(1); });
