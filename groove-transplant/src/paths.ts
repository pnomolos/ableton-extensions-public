import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Prefer the Alpha User Library when present; fall back to the standard library.
// Both paths must be checked at runtime since the Alpha library may not exist on
// a tester's machine or if Live is reinstalled without Alpha.
function userLibraryBase(): string {
  const alpha    = join(homedir(), "Music", "Ableton Alpha", "User Library");
  const standard = join(homedir(), "Music", "Ableton", "User Library");
  return existsSync(alpha) ? alpha : standard;
}

export function userLibraryGrooves(): string {
  return join(userLibraryBase(), "Grooves");
}

export function userLibrarySamples(): string {
  return join(userLibraryBase(), "Samples");
}
