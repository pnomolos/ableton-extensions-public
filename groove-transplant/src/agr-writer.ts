import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { GrooveProfile } from "@arclight/core";
import { userLibraryGrooves, userLibrarySamples } from "./paths.js";

const TEMPLATE_PATH =
  "/Applications/Ableton Live 12.4 Alpha.app/Contents/App-Resources/Core Library/Grooves/Swing/Logic/Swing Logic 16ths 59.agr";
const TEMPLATE_NAME = "Logic 16 Swing 59"; // 17 chars — known name in template

const NOTE_SIZE  = 25; // 8(time) + 8(duration) + 4(vel) + 4(0) + 1(flag)
const NOTE_COUNT = 16; // 1 bar × 1/16

// The first note record in the template starts at time=0.0 followed by duration=0.0625 (1/16 beat).
// We use that 16-byte binary signature to locate the note block directly, rather than
// relying on a fixed offset after the \x0dMidiNoteEvent tag (which has variable-length headers).
const NOTE_DURATION_BUF = Buffer.allocUnsafe(8);
NOTE_DURATION_BUF.writeDoubleLE(0.0625, 0);
const FIRST_NOTE_SIGNATURE = Buffer.concat([Buffer.alloc(8), NOTE_DURATION_BUF]); // 0.0 + 0.0625

export function writeAgr(profile: GrooveProfile, outputDir: string): string {
  const tmpl = readFileSync(TEMPLATE_PATH);

  // Locate template name (u32 LE char count + UTF-16LE string)
  const tmplNameBuf = Buffer.from(TEMPLATE_NAME, "utf16le");
  const tmplLenBuf  = Buffer.allocUnsafe(4);
  tmplLenBuf.writeUInt32LE(TEMPLATE_NAME.length, 0);
  const tmplNameFull = Buffer.concat([tmplLenBuf, tmplNameBuf]);
  const nameOffset = tmpl.indexOf(tmplNameFull);
  if (nameOffset < 0) throw new Error("agr-writer: template name not found");
  const oldNameEnd = nameOffset + 4 + TEMPLATE_NAME.length * 2;

  // Locate note records by the first note's binary signature: time=0.0 + duration=0.0625
  const noteDataOffset = tmpl.indexOf(FIRST_NOTE_SIGNATURE);
  if (noteDataOffset < 0) throw new Error("agr-writer: note data signature not found");
  const oldNoteDataEnd = noteDataOffset + NOTE_COUNT * NOTE_SIZE;

  // New name — sanitise, cap at 50 chars
  const cleanName = profile.name.slice(0, 50).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const newLenBuf = Buffer.allocUnsafe(4);
  newLenBuf.writeUInt32LE(cleanName.length, 0);
  const newNameBuf = Buffer.from(cleanName, "utf16le");

  // Build 16 note records
  //   grid position i (0..15) → absolute beat = i * 0.25 + groove offset
  //   velocity: 100 ± 40 scaled from velocityOffsets (-1..1)
  const notesBuf  = Buffer.allocUnsafe(NOTE_COUNT * NOTE_SIZE);
  const slots     = profile.offsets;
  const velSlots  = profile.velocityOffsets ?? new Array(slots.length).fill(0) as number[];
  const numSlots  = slots.length;

  for (let i = 0; i < NOTE_COUNT; i++) {
    const slot = i % numSlots;
    const time = Math.max(0, i * 0.25 + slots[slot]);
    const vel  = Math.max(1, Math.min(127, Math.round(100 + velSlots[slot] * 40)));
    const off  = i * NOTE_SIZE;
    notesBuf.writeDoubleLE(time, off);
    notesBuf.writeDoubleLE(0.0625, off + 8);
    notesBuf.writeFloatLE(vel, off + 16);
    notesBuf.writeFloatLE(0.0, off + 20);
    notesBuf[off + 24] = 1;
  }

  // Assemble: prefix | new name | middle (incl. empty clip name + metadata + marker) | notes | trailer
  const output = Buffer.concat([
    tmpl.slice(0, nameOffset),
    newLenBuf,
    newNameBuf,
    tmpl.slice(oldNameEnd, noteDataOffset),
    notesBuf,
    tmpl.slice(oldNoteDataEnd),
  ]);

  mkdirSync(outputDir, { recursive: true });
  const filename = `${cleanName}.agr`;
  const filepath = join(outputDir, filename);
  writeFileSync(filepath, output);
  return filepath;
}

export function grooveOutputDir(): string {
  return join(userLibraryGrooves(), "Groove Transplant");
}

export function drumSampleOutputDir(clipName: string): string {
  const rawCleaned = clipName.slice(0, 40).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  // Reject "." / ".." / empty — otherwise join() would escape the intended
  // subdirectory (e.g. a clip literally named ".." would write to the parent).
  const cleaned = rawCleaned === "." || rawCleaned === ".." || rawCleaned === ""
    ? "Drum Rack"
    : rawCleaned;
  return join(userLibrarySamples(), "Groove Transplant", cleaned);
}
