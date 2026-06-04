// Native LFO configuration — drive Live's bundled LFO device (Max for Live,
// Live 12 Suite) from lidal. Once the user has dropped an LFO onto a track
// and manually clicked Map on each modulation slot they want active, this
// module writes the LFO's global state (rate, shape, depth, etc.) and any
// per-slot Min/Max/ModAmount/Polarity/Modulation values via the extras'
// async DeviceParameter.setValue API. Live's audio thread then runs the
// modulation natively — no per-cycle JS cost.
//
// Surface (sandbox-callable):
//   lfo "TrackName" { rate: "1/8", shape: "sine", depth: 70, ...,
//                     slots: [ { min: 30, max: 70, amount: 50 }, ... ] }
//
// The Map destination cannot be set programmatically (the Map button enters
// Live's transient Map-mode UI rather than exposing a settable target).
// Slot mappings are a one-time-per-slot manual step in Live's UI; once
// established they persist with the Live Set.

import type { ExtensionContext, Track, DeviceParameter } from "@ableton-extensions/sdk";

// ── Public config types ─────────────────────────────────────────────────

export interface LfoSlotConfig {
  /** Lower bound of the LFO's output range as fed into the mapped target (0..100). */
  min?: number;
  /** Upper bound of the LFO's output range as fed into the mapped target (0..100). */
  max?: number;
  /** Modulation depth / direction (-100..100). */
  amount?: number;
  /** Polarity of the LFO's output applied to this slot. */
  polarity?: "+/-" | "+";
  /** Modulation mode (Remote = MIDI-mappable knob; Mod = audio-rate modulation). */
  modulation?: "Remote" | "Mod";
}

export interface LfoConfig {
  /** Global LFO depth (0..100). */
  depth?: number;
  /** Rate. `"1/8"` etc. enables Sync mode; number enables Free (Hz) mode. */
  rate?: number | string;
  /** Waveform — case-insensitive name lookup ("sine", "tri", "random", …) or numeric index. */
  shape?: number | string;
  /** Phase offset (0..100). */
  phase?: number;
  /** Output smoothing (0..100). */
  smooth?: number;
  /** Step count for sample-and-hold shapes — `"Off"` or 1..24. */
  steps?: number | string;
  /** Per-cycle jitter on rate (0..100). */
  jitter?: number;
  /** DC offset of the LFO output (-100..100). */
  offset?: number;
  /** Waveform symmetry (-100..100). */
  waveShape?: number;
  /** Force Time Mode explicitly ("Free" | "Sync"). Usually inferred from `rate`. */
  timeMode?: "Free" | "Sync";
  /** Toggles. */
  hold?: boolean;
  retrigger?: boolean;
  x10?: boolean;
  deviceOn?: boolean;
  /** Mod Source — internal LFO routing slot (1..8). */
  modSource?: number;
  /** Per-slot config; index 0 = slot 1, index 7 = slot 8. Unspecified slots are left untouched. */
  slots?: LfoSlotConfig[];
}

export interface LfoApplyResult {
  trackName: string;
  device: string;
  /** Parameter writes that completed successfully. */
  applied: { name: string; value: number; slot?: number }[];
  /** Parameter writes that errored — collected rather than thrown so partial application is observable. */
  failed: { name: string; raw: unknown; error: string; slot?: number }[];
}

// ── Constants ───────────────────────────────────────────────────────────

const LFO_DEVICE_NAME = "LFO";
const MAX_SLOTS = 8;

// Map of public config key → LFO parameter name + value coercion. Order of
// application matters for `timeMode`/`rate` (timeMode must be set first so the
// right `Rate` parameter — Free or Sync — receives the value).
const GLOBAL_KEYS: ReadonlyArray<{
  key: keyof LfoConfig;
  paramName: string;
}> = [
  // timeMode goes first so a `rate: "1/8"` write lands on the Sync Rate slot,
  // not the Free one (the two share the same param name but differ by
  // isQuantized; selecting the right one requires Time Mode to be settled).
  { key: "timeMode", paramName: "Time Mode" },
  { key: "deviceOn", paramName: "Device On" },
  { key: "depth", paramName: "Depth" },
  { key: "shape", paramName: "Shape" },
  { key: "phase", paramName: "Phase" },
  { key: "smooth", paramName: "Smooth" },
  { key: "steps", paramName: "Steps" },
  { key: "jitter", paramName: "Jitter" },
  { key: "offset", paramName: "Offset" },
  { key: "waveShape", paramName: "Wave Shape" },
  { key: "hold", paramName: "Hold" },
  { key: "retrigger", paramName: "Re-Trigger" },
  { key: "x10", paramName: "x10" },
  { key: "modSource", paramName: "Mod Source" },
  // rate goes last among singletons so timeMode has settled. It needs special
  // handling (two parameters share the name) — see `pickRateParam` below.
];

// Per-slot config key → parameter name. Map/Unmap intentionally omitted —
// they're UI triggers, not settable destination configuration.
const SLOT_KEYS: ReadonlyArray<{
  key: keyof LfoSlotConfig;
  paramName: string;
}> = [
  { key: "min", paramName: "Min" },
  { key: "max", paramName: "Max" },
  { key: "amount", paramName: "ModAmount" },
  { key: "polarity", paramName: "Polarity" },
  { key: "modulation", paramName: "Modulation" },
];

// ── Helpers ─────────────────────────────────────────────────────────────

interface ValueItem { name: string; shortName?: string }

// Coerce a user-supplied value to the numeric value the parameter expects.
// Quantized params accept either an index (number) or a name string that
// matches one of `valueItems` (case-insensitive). Boolean booleans coerce to
// 0/1 for on/off-shaped quantized params.
function coerceValue(
  raw: unknown,
  isQuantized: boolean,
  valueItems: ValueItem[],
  min: number,
  max: number,
  paramName: string,
): number {
  if (typeof raw === "boolean") {
    // Boolean only makes sense for 2-state quantized params (Device On / Hold / …).
    if (!isQuantized || valueItems.length !== 2) {
      throw new Error(
        `lfo: ${paramName} expects a ${isQuantized ? "named option" : "number"}, got boolean`,
      );
    }
    return raw ? 1 : 0;
  }

  if (typeof raw === "string") {
    if (!isQuantized || valueItems.length === 0) {
      // Continuous param given a string — could be a future numeric-string form
      // ("70"), so try parseFloat as a courtesy before rejecting.
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n)) throw new Error(`lfo: ${paramName} expects a number, got '${raw}'`);
      return clamp(n, min, max);
    }
    const needle = raw.toLowerCase().trim();
    const idx = valueItems.findIndex(
      (it) => it.name.toLowerCase() === needle || it.shortName?.toLowerCase() === needle,
    );
    if (idx < 0) {
      throw new Error(
        `lfo: ${paramName} = '${raw}' — not one of [${valueItems.map((i) => i.name).join(", ")}]`,
      );
    }
    return idx;
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return clamp(raw, min, max);
  }

  throw new Error(`lfo: ${paramName} expects number|string|boolean, got ${typeof raw}`);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// LFO has TWO parameters literally named "Rate" — one continuous (Free mode,
// 0..40 Hz) and one quantized (Sync mode, 24 named tempo divisions). Select
// based on the user-supplied value's type: string ⇒ Sync, number ⇒ Free.
function pickRateParam(
  rateParams: DeviceParameter<"1.0.0">[],
  raw: unknown,
): DeviceParameter<"1.0.0"> {
  if (rateParams.length !== 2) {
    throw new Error(
      `lfo: expected exactly 2 'Rate' params on the LFO device, found ${rateParams.length} — device may not be the bundled Live 12 LFO`,
    );
  }
  const wantQuantized = typeof raw === "string";
  for (const p of rateParams) {
    try { if (p.isQuantized === wantQuantized) return p; } catch { /* fall through */ }
  }
  throw new Error(
    `lfo: rate = ${JSON.stringify(raw)} — couldn't find ${wantQuantized ? "Sync (quantized)" : "Free (continuous)"} Rate slot`,
  );
}

// Find the first LFO device on the top-level device chain of `track`. Throws
// if zero or multiple LFOs are present (multi-LFO addressing is a v2 concern).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findLfoDevice(track: Track<"1.0.0">): any {
  const lfos = (track.devices ?? []).filter((d) => {
    try { return d.name === LFO_DEVICE_NAME; } catch { return false; }
  });
  if (lfos.length === 0) {
    throw new Error(
      `lfo: track "${track.name}" has no LFO device. Drop an LFO from the Max for Live browser onto the track, then click Map on each slot you want active, then re-evaluate.`,
    );
  }
  if (lfos.length > 1) {
    throw new Error(
      `lfo: track "${track.name}" has ${lfos.length} LFO devices. v1 only addresses single LFOs — remove the extras or wait for multi-LFO addressing.`,
    );
  }
  return lfos[0];
}

// Group parameters by name — each "Min" slot is a distinct DeviceParameter
// even though they all share the name. Iteration order is preserved, so
// `byName.get("Min")[0]` is slot 0, [7] is slot 7.
function groupByName(
  params: DeviceParameter<"1.0.0">[],
): Map<string, DeviceParameter<"1.0.0">[]> {
  const out = new Map<string, DeviceParameter<"1.0.0">[]>();
  for (const p of params) {
    let name: string;
    try { name = p.name; } catch { continue; }
    const bucket = out.get(name);
    if (bucket) bucket.push(p);
    else out.set(name, [p]);
  }
  return out;
}

// ── Public entry ────────────────────────────────────────────────────────

/**
 * Apply `config` to the first LFO device on the named track. Each parameter
 * write is its own undo entry (SDK 0.0.5 doesn't expose gesture-bracketing
 * for parameter sets); for a typical LFO config of 4-8 fields that's fine.
 *
 * Returns a result describing every write that succeeded and every one that
 * failed (failures are collected rather than thrown so partial application
 * is observable in the editor log). The Promise resolves when all writes
 * have settled.
 */
export async function applyLfoConfig(
  ext: ExtensionContext<"1.0.0">,
  trackName: string,
  config: LfoConfig,
): Promise<LfoApplyResult> {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`lfo: config must be an object, got ${Array.isArray(config) ? "array" : typeof config}`);
  }

  const allTracks = ext.application.song.tracks;
  // Live's `#` prefix is a display placeholder for the track index — a track
  // stored as `# Analog` renders in Live's UI as `1 Analog`, `2 Analog`, etc.
  // Match either form so users can type whichever they see in the chrome.
  const matchTrack = (storedName: string, query: string, index: number): boolean => {
    if (storedName === query) return true;
    if (storedName.startsWith("#")) {
      const rendered = `${index + 1}${storedName.slice(1)}`;
      if (rendered === query) return true;
    }
    return false;
  };
  const track = allTracks.find((t, i) => matchTrack(t.name, trackName, i));
  if (!track) {
    const available = allTracks.map((t, i) => {
      // Show both the stored name and (if different) the rendered form so the
      // user can paste either back into their config.
      if (t.name.startsWith("#")) return `"${t.name}" (renders as "${i + 1}${t.name.slice(1)}")`;
      return `"${t.name}"`;
    }).join(", ");
    throw new Error(
      `lfo: track "${trackName}" not found. Available: ${available || "(none)"}`,
    );
  }

  const lfo = findLfoDevice(track);
  const deviceName: string = (() => {
    try { return lfo.name; } catch { return LFO_DEVICE_NAME; }
  })();
  const params: DeviceParameter<"1.0.0">[] = lfo.parameters;
  const byName = groupByName(params);

  const applied: LfoApplyResult["applied"] = [];
  const failed: LfoApplyResult["failed"] = [];

  const writeOne = async (
    paramName: string,
    raw: unknown,
    // Override the param lookup (e.g. for the dual-Rate disambiguation).
    paramOverride?: DeviceParameter<"1.0.0">,
    slotIndex?: number,
  ): Promise<void> => {
    const param = paramOverride ?? byName.get(paramName)?.[0];
    if (!param) {
      failed.push({ name: paramName, raw, error: `parameter '${paramName}' not found on LFO`, slot: slotIndex });
      return;
    }
    let isQuantized: boolean;
    let valueItems: ValueItem[];
    let min: number, max: number;
    try {
      isQuantized = param.isQuantized;
      valueItems = param.valueItems ?? [];
      min = param.min;
      max = param.max;
    } catch (e) {
      failed.push({ name: paramName, raw, error: `metadata read failed: ${e instanceof Error ? e.message : String(e)}`, slot: slotIndex });
      return;
    }
    let value: number;
    try {
      value = coerceValue(raw, isQuantized, valueItems, min, max, paramName);
    } catch (e) {
      failed.push({ name: paramName, raw, error: e instanceof Error ? e.message : String(e), slot: slotIndex });
      return;
    }
    try {
      await param.setValue(value);
      applied.push({ name: paramName, value, slot: slotIndex });
    } catch (e) {
      failed.push({ name: paramName, raw, error: `setValue failed: ${e instanceof Error ? e.message : String(e)}`, slot: slotIndex });
    }
  };

  // Pass 1: global parameters (timeMode FIRST per ordering above).
  for (const { key, paramName } of GLOBAL_KEYS) {
    if (!(key in config)) continue;
    const raw = (config as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    await writeOne(paramName, raw);
  }

  // Pass 2: rate (after timeMode has settled).
  if (config.rate !== undefined) {
    const rateParams = byName.get("Rate") ?? [];
    try {
      const param = pickRateParam(rateParams, config.rate);
      await writeOne("Rate", config.rate, param);
    } catch (e) {
      failed.push({ name: "Rate", raw: config.rate, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Pass 3: per-slot parameters. Sparse array — only fill what's specified.
  if (Array.isArray(config.slots)) {
    if (config.slots.length > MAX_SLOTS) {
      failed.push({
        name: "slots",
        raw: config.slots.length,
        error: `LFO has ${MAX_SLOTS} slots; ignoring extras past index ${MAX_SLOTS - 1}`,
      });
    }
    for (let i = 0; i < Math.min(config.slots.length, MAX_SLOTS); i++) {
      const slot = config.slots[i];
      if (slot == null) continue;
      if (typeof slot !== "object" || Array.isArray(slot)) {
        failed.push({ name: `slot ${i}`, raw: slot, error: "slot config must be an object", slot: i });
        continue;
      }
      for (const { key, paramName } of SLOT_KEYS) {
        if (!(key in slot)) continue;
        const raw = (slot as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        const bucket = byName.get(paramName);
        const param = bucket?.[i];
        if (!param) {
          failed.push({
            name: paramName,
            raw,
            error: `slot ${i} has no '${paramName}' parameter (LFO only exposes ${bucket?.length ?? 0} '${paramName}' slots)`,
            slot: i,
          });
          continue;
        }
        await writeOne(paramName, raw, param, i);
      }
    }
  }

  return { trackName, device: deviceName, applied, failed };
}
