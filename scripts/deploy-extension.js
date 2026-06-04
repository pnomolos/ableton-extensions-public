#!/usr/bin/env node
/**
 * Shared deploy helper for Arclight extensions.
 *
 * Called from each extension's scripts/deploy.js:
 *   require("../../scripts/deploy-extension.js")(__dirname)
 *
 * Copies manifest.json and dist/extension.js to:
 *   ~/Music/Ableton Alpha/User Library/Extensions/<slug>/
 *
 * Creates the target directory if it does not exist.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// Walk the runtime dep graph for `pkgName` and return a Map<name, absoluteDir> of every
// package transitively reachable from it. Filesystem-based — climbs node_modules up to
// the workspace root, gracefully skipping deps whose package.json is missing (some are
// over-declared and not actually present at install time).
// Resolve symlinks at the start so the walk also picks up pnpm's
// `.pnpm/<pkg>@<ver>/node_modules/<sub>` sibling-symlink layout for sub-
// dependencies. No-op for npm's hoisted tree.
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
  // dependencies + optionalDependencies — peerDependencies are not bundled by convention.
  // Optional deps are common for native bindings (prebuild-install, node-pre-gyp helpers).
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

module.exports = function deployExtension(callerScriptsDir) {
  const ROOT   = path.resolve(callerScriptsDir, "..");
  const slug   = path.basename(ROOT);
  const dest   = path.join(os.homedir(), "Music", "Ableton Alpha", "User Library", "Extensions", slug);
  const destDist = path.join(dest, "dist");

  fs.mkdirSync(destDist, { recursive: true });

  fs.copyFileSync(path.join(ROOT, "manifest.json"),      path.join(dest, "manifest.json"));
  fs.copyFileSync(path.join(ROOT, "dist", "extension.js"), path.join(destDist, "extension.js"));

  // Native deps: copy each runtime package + its transitive deps into <dest>/node_modules/
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const nativeDeps = Array.isArray(pkg.arclightNativeDeps) ? pkg.arclightNativeDeps : [];
  if (nativeDeps.length) {
    const collected = new Map();
    for (const dep of nativeDeps) collectDepTree(dep, ROOT, collected);
    const destNm = path.join(dest, "node_modules");
    fs.rmSync(destNm, { recursive: true, force: true });
    for (const [name, dir] of collected) {
      copyDirRecursive(dir, path.join(destNm, name));
    }
    console.log(`  copied ${collected.size} native-dep packages: ${[...collected.keys()].sort().join(", ")}`);
  }

  console.log(`✓ Deployed ${slug} → ${dest}`);
};
