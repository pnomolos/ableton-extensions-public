import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Resolve the User Library at runtime: $ABLETON_USER_LIBRARY when set (the same
// variable dev-launch.sh and the deploy scripts honour), then the Alpha library
// when present, then the standard library. The fallbacks must be checked at
// runtime since the Alpha library may not exist on a tester's machine or if
// Live is reinstalled without Alpha.
function userLibraryBase(): string {
  const fromEnv = process.env.ABLETON_USER_LIBRARY;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
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
