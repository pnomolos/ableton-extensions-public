import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { GrooveProfile } from "@arclight/core";

export class GrooveStore {
  private dir: string;

  constructor(storageDirectory: string) {
    this.dir = join(storageDirectory, "grooves");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  save(profile: GrooveProfile): void {
    const path = join(this.dir, `${profile.id}.json`);
    writeFileSync(path, JSON.stringify(profile, null, 2), "utf-8");
    console.log(`[GrooveTransplant] Saved groove: ${profile.name} → ${path}`);
  }

  loadAll(): GrooveProfile[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          // Profiles without `version` are legacy pre-1.0 files; still load fine
          // since `version` is optional in the GrooveProfile interface.
          return JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as GrooveProfile;
        } catch {
          return null;
        }
      })
      .filter((p): p is GrooveProfile => p !== null)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  delete(id: string): void {
    const path = join(this.dir, `${id}.json`);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}
