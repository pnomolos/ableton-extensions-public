#!/usr/bin/env node
/**
 * Shared packaging helper for Arclight extensions.
 *
 * Called from each extension's scripts/pack.js:
 *   require("../../scripts/pack-extension.js")(__dirname)
 *
 * Output: <extension>/releases/<slug>-v{version}.zip
 *   (or <slug>-v{version}-{platform}-{arch}.zip for native-dep extensions, one per target)
 *
 * The zip contains:
 *   manifest.json
 *   dist/extension.js
 *   node_modules/<dep>/**  (when package.json lists arclightNativeDeps)
 *
 * Cross-platform builds: set `arclightPackTargets` in the extension's package.json
 * to a list of `{platform, arch}` objects. For each target a separate zip is
 * produced; native modules with a `binding.gyp` are cross-compiled via node-gyp
 * when the target differs from the host, and `prebuilds/` directories are slimmed
 * to the matching `<name>-<platform>-<arch>` subdirectory.
 *
 * Cross-compile constraints: only same-OS-different-arch targets are supported
 * (darwin-arm64 ↔ darwin-x64). Cross-OS builds (darwin → linux/win) need a host
 * of that OS — this helper will error if asked.
 *
 * Testers install by unzipping into:
 *   <User Library>/Extensions/<slug>/
 * then reloading the Extension Host (kill -HUP <pid>).
 */

const { execSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

// Walk node_modules upward from `fromDir` to find `pkgName`. Matches the
// resolution logic in deploy-extension.js so the packed and deployed dep
// trees stay identical.
//
// We resolve symlinks at the start so the walk also picks up pnpm's
// `.pnpm/<pkg>@<ver>/node_modules/<sub>` sibling-symlink layout for sub-
// dependencies. With npm's hoisted tree this is a no-op (the input is
// already a real path); with pnpm, the input is a symlink into the
// virtual store, and the real parent is where sub-deps live.
function findPackageDir(pkgName, fromDir) {
  let dir;
  try { dir = fs.realpathSync(fromDir); } catch { dir = fromDir; }
  while (true) {
    const candidate = path.join(dir, "node_modules", pkgName);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectDepTree(pkgName, fromDir, collected = new Map(), seen = new Set()) {
  if (seen.has(pkgName)) return collected;
  seen.add(pkgName);
  const pkgDir = findPackageDir(pkgName, fromDir);
  if (!pkgDir) {
    if (collected.size === 0) {
      throw new Error(`Native dep '${pkgName}' not installed (searched from ${fromDir})`);
    }
    console.warn(`  [warn] sub-dep '${pkgName}' not found on disk — skipping`);
    return collected;
  }
  collected.set(pkgName, pkgDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  for (const dep of Object.keys(allDeps)) {
    collectDepTree(dep, pkgDir, collected, seen);
  }
  return collected;
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(sp);
      try { fs.symlinkSync(target, dp); } catch { fs.copyFileSync(sp, dp); }
    } else if (entry.isDirectory()) {
      copyDirRecursive(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}

// True if any .node binary exists under dir (build output or shipped prebuilds).
function hasNativeBinary(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".node")) return true;
    if (entry.isDirectory() && entry.name !== "node_modules" && hasNativeBinary(p)) return true;
  }
  return false;
}

// Recompile a node-gyp-driven native module in place for a target arch.
// Requires `binding.gyp` at the module root. On macOS, --target_arch=x64|arm64
// instructs gyp to set ARCHS in the Xcode build, producing a Mach-O for the
// requested arch. Cross-OS builds are not supported here.
function crossCompileNativeModule(stagedDir, target, hostPlatform) {
  if (target.platform !== hostPlatform) {
    throw new Error(
      `cannot cross-compile to ${target.platform}-${target.arch} from ${hostPlatform}: ` +
      `same-OS-different-arch is the only supported cross build. Run pack on a ${target.platform} host.`,
    );
  }
  // Clean any host-arch build artifacts before recompiling.
  fs.rmSync(path.join(stagedDir, "build"), { recursive: true, force: true });
  execSync(
    `npx --yes node-gyp rebuild --target_arch=${target.arch} --arch=${target.arch}`,
    { cwd: stagedDir, stdio: "inherit" },
  );
}

// Drop every prebuilds/<name>-* directory that doesn't match the target.
// pkg-prebuilds (used by @julusian/midi) picks the directory at load time by
// matching process.platform-process.arch; shipping non-matching prebuilds
// inflates the zip but doesn't break behaviour. We trim them for hygiene.
function slimPrebuildsDir(modDir, target) {
  const prebuildsDir = path.join(modDir, "prebuilds");
  if (!fs.existsSync(prebuildsDir)) return;
  const wantedSuffix = `-${target.platform}-${target.arch}`;
  for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith(wantedSuffix)) {
      fs.rmSync(path.join(prebuildsDir, entry.name), { recursive: true, force: true });
    }
  }
}

function buildOneTarget({ target, ROOT, MANIFEST, BUNDLE, nativeDeps, slug, version, zipPath, extraDistFiles }) {
  const hostPlatform = process.platform;
  const hostArch     = process.arch;
  const isHost       = target.platform === hostPlatform && target.arch === hostArch;

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pack-${slug}-${target.platform}-${target.arch}-`));
  try {
    fs.copyFileSync(MANIFEST, path.join(stageRoot, "manifest.json"));
    fs.mkdirSync(path.join(stageRoot, "dist"), { recursive: true });
    fs.copyFileSync(BUNDLE, path.join(stageRoot, "dist", "extension.js"));
    // Optional extra files copied into <dest>/dist/ alongside extension.js.
    // Declared per-extension in package.json as `arclightExtraDistFiles: ["editor-client.js", …]`.
    // Each entry is resolved against the extension's dist/ directory; missing
    // files are warned about but do not abort the pack.
    for (const rel of extraDistFiles || []) {
      const src = path.join(ROOT, "dist", rel);
      if (!fs.existsSync(src)) {
        console.warn(`  [warn] extra dist file '${rel}' not found at ${src} — skipping`);
        continue;
      }
      const dst = path.join(stageRoot, "dist", rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }

    const collected = new Map();
    for (const dep of nativeDeps) collectDepTree(dep, ROOT, collected);

    const stageNm = path.join(stageRoot, "node_modules");
    for (const [name, dir] of collected) {
      const dst = path.join(stageNm, name);
      copyDirRecursive(dir, dst);

      // Slim per-target.
      slimPrebuildsDir(dst, target);

      // Cross-compile any module with a top-level binding.gyp that isn't a
      // pkg-prebuilds package (those use the prebuilds/ dir, not build/).
      const hasGyp = fs.existsSync(path.join(dst, "binding.gyp"));
      const hasPrebuilds = fs.existsSync(path.join(dst, "prebuilds"));
      if (hasGyp && !hasPrebuilds && !isHost) {
        console.log(`  cross-compiling ${name} for ${target.platform}-${target.arch}…`);
        crossCompileNativeModule(dst, target, hostPlatform);
      } else if (hasGyp && !hasPrebuilds && !hasNativeBinary(dst)) {
        // Gyp-built module never compiled (pnpm blocks install scripts unless
        // approved) — shipping it would degrade the extension at runtime.
        throw new Error(
          `native dep '${name}' has no compiled .node binary. ` +
          `Run: pnpm rebuild ${name}   (or pnpm approve-builds)`,
        );
      }
    }
    const depSummary = [...collected.keys()].sort().join(", ");
    console.log(`  staged ${collected.size} native-dep packages (${target.platform}-${target.arch}): ${depSummary}`);

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    execSync(
      `zip -r "${zipPath}" manifest.json dist node_modules`,
      { cwd: stageRoot, stdio: "inherit" },
    );
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

module.exports = function packExtension(callerScriptsDir) {
  const ROOT     = path.resolve(callerScriptsDir, "..");
  const MANIFEST = path.join(ROOT, "manifest.json");
  const BUNDLE   = path.join(ROOT, "dist", "extension.js");
  const PKG_JSON = path.join(ROOT, "package.json");
  const RELEASES = path.join(ROOT, "releases");

  const manifest    = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const pkg         = JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
  const version     = manifest.version;
  const slug        = path.basename(ROOT);
  const displayName = manifest.name ?? slug;
  const nativeDeps  = Array.isArray(pkg.arclightNativeDeps) ? pkg.arclightNativeDeps : [];
  const extraDistFiles = Array.isArray(pkg.arclightExtraDistFiles) ? pkg.arclightExtraDistFiles : [];

  // Targets default to the host platform/arch. Extensions with native deps can
  // override with `arclightPackTargets` in package.json — a list of
  // `{ platform, arch }` objects. Each target produces its own zip.
  let targets;
  if (Array.isArray(pkg.arclightPackTargets) && pkg.arclightPackTargets.length > 0) {
    targets = pkg.arclightPackTargets;
  } else {
    targets = [{ platform: process.platform, arch: process.arch }];
  }

  if (!fs.existsSync(BUNDLE)) {
    console.error("ERROR: dist/extension.js not found — run build first");
    process.exit(1);
  }
  const stat = fs.statSync(BUNDLE);
  if (stat.size < 10_000) {
    console.error(`ERROR: dist/extension.js is suspiciously small (${stat.size} bytes)`);
    process.exit(1);
  }

  try {
    execSync(`node --check "${BUNDLE}"`, { stdio: "inherit" });
  } catch {
    console.error("ERROR: dist/extension.js failed syntax check");
    process.exit(1);
  }

  // Lidal-specific sentinel: verify the correct bundle was packed.
  // A wrong-bundle ship (e.g. editor-client.js as extension.js) would be
  // missing the main command registration string.
  if (slug === "lidal") {
    const bundleText = fs.readFileSync(BUNDLE, "utf8");
    if (!bundleText.includes("lidal.openEditor")) {
      console.error("ERROR: dist/extension.js does not contain 'lidal.openEditor' — wrong bundle?");
      process.exit(1);
    }
  }

  fs.mkdirSync(RELEASES, { recursive: true });

  if (nativeDeps.length === 0) {
    // Pure-JS path: single platform-agnostic zip.
    const zipName = `${slug}-v${version}.zip`;
    const zipPath = path.join(RELEASES, zipName);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const distEntries = ["dist/extension.js"];
    for (const rel of extraDistFiles) {
      const src = path.join(ROOT, "dist", rel);
      if (fs.existsSync(src)) distEntries.push(`dist/${rel}`);
      else console.warn(`  [warn] extra dist file '${rel}' not found — skipping`);
    }
    execSync(
      `zip "${zipPath}" manifest.json ${distEntries.map((d) => `"${d}"`).join(" ")}`,
      { cwd: ROOT, stdio: "inherit" },
    );
    const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
    console.log(`\n✓ ${zipName}  (${sizeKb} KB)`);
    console.log(`  ${zipPath}`);
    console.log(`
Install instructions for testers:
  1. Unzip into your Live "User Library/Extensions/" folder
     so the result is: Extensions/${slug}/{manifest.json,dist/extension.js}
  2. Reload Extension Host: kill -HUP <pid>  (pid shown on startup)
  3. The "${displayName}" extension should appear in Live's Extensions menu.
`);
    return;
  }

  // Native-dep path: one zip per target.
  const built = [];
  for (const target of targets) {
    const zipName = `${slug}-v${version}-${target.platform}-${target.arch}.zip`;
    const zipPath = path.join(RELEASES, zipName);
    console.log(`\n→ Building ${zipName}`);
    buildOneTarget({ target, ROOT, MANIFEST, BUNDLE, nativeDeps, slug, version, zipPath, extraDistFiles });
    built.push({ target, zipName, zipPath });
  }

  console.log(`\nBuilt ${built.length} target zip(s):`);
  for (const b of built) {
    const sizeKb = Math.round(fs.statSync(b.zipPath).size / 1024);
    console.log(`  ✓ ${b.zipName}  (${sizeKb} KB)`);
  }
  console.log(`
Install instructions for testers:
  1. Pick the zip matching your platform-arch.
  2. Unzip into your Live "User Library/Extensions/" folder
     so the result is: Extensions/${slug}/{manifest.json,dist/extension.js,node_modules/}
  3. Reload Extension Host: kill -HUP <pid>  (pid shown on startup)
  4. The "${displayName}" extension should appear in Live's Extensions menu.
`);
};
