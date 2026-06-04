// GM drum voice → MIDI note. Aliases kept generous so common TidalCycles names all work.
export const DRUM_MAP: Record<string, number> = {
  bd: 36, kick: 36, kk: 36,
  rim: 37, sidestick: 37, ss: 37,
  sd: 38, snare: 38, sn: 38,
  cp: 39, clap: 39,
  ehs: 40,
  ft: 41, lft: 41, tom1: 41,
  hh: 42, ch: 42,
  ht: 43, tom2: 43,
  ph: 44, ped: 44, pedal: 44,
  mt: 45, tom3: 45,
  oh: 46, hho: 46,
  hmt: 48,
  cy: 49, crash: 49, cr: 49,
  ride: 51, rd: 51,
  cb: 56, cowbell: 56,
};

// Per-orbit override layered on top of DRUM_MAP; a partial override still
// falls through to the global table for unspecified names.
const OVERRIDES: Map<number, Record<string, number>> = new Map();

export function setDrumMap(orbit: number, map: Record<string, number>): void {
  OVERRIDES.set(orbit, map);
}

export function clearDrumMap(orbit: number): void {
  OVERRIDES.delete(orbit);
}

export function getDrumMap(orbit: number): Record<string, number> | undefined {
  return OVERRIDES.get(orbit);
}

export function drumNameToMidi(name: string): number | null {
  const v = DRUM_MAP[name.toLowerCase()];
  return v ?? null;
}

export function resolveDrum(orbit: number, name: string): number | null {
  const lower = name.toLowerCase();
  const override = OVERRIDES.get(orbit);
  if (override && lower in override) return override[lower];
  return DRUM_MAP[lower] ?? null;
}

// "bd:36 sn=38, tom1:41" — whitespace/,/; separate, : or = splits.
export function parseDrumMapSpec(spec: string): Record<string, number> {
  const out: Record<string, number> = {};
  const tokens = spec.split(/[\s,;]+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    const m = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(-?\d+)$/);
    if (!m) throw new Error(`drumMap: bad pair "${tok}" — expected name:NN or name=NN`);
    const name = m[1].toLowerCase();
    const note = parseInt(m[2], 10);
    if (!Number.isFinite(note) || note < 0 || note > 127) {
      throw new Error(`drumMap: note ${note} for "${name}" out of MIDI range 0..127`);
    }
    out[name] = note;
  }
  return out;
}

// "/path/BD 909.aif" → "bd"; "Conga Lo 808" → "conga_lo".  Pure-digit tokens
// (909/808/707/…) are dropped as kit-tag noise so stock Ableton names map cleanly.
export function sampleFilenameToAlias(filePath: string): string | null {
  const slashIdx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  // Split on whitespace / dash / underscore; drop pure-digit "kit tag" tokens
  // (707/808/909/etc.) and any bare numbers that aren't joined to letters.
  const parts = stem
    .split(/[\s_\-]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^\d+$/.test(p));
  if (parts.length === 0) return null;
  const cleaned = parts.join("_").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (cleaned.length === 0) return null;
  // Aliases round-trip through parseDrumMapSpec, whose ident regex disallows a
  // leading digit. Prefix one so filenames like "1stHit kick" don't break eval.
  return /^[0-9]/.test(cleaned) ? "_" + cleaned : cleaned;
}
