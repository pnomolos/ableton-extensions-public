import { describe, it, expect } from "vitest";
import { extractBpmFromText } from "../text-utils.js";

describe("extractBpmFromText", () => {
  // ── number before "bpm" ──────────────────────────────────────────────────────

  it("matches '<n> BPM' at end of name (real-world: Aloe Vera 98 BPM)", () => {
    expect(extractBpmFromText("Aloe Vera 98 BPM")).toBe(98);
  });

  it("matches '<n> BPM' with uppercase", () => {
    expect(extractBpmFromText("Drum Loop 120 BPM")).toBe(120);
  });

  it("matches '<n>bpm' with no space when preceded by a non-word character", () => {
    // \b fires between space/'(' and a digit — but NOT between '_'/letter and a digit
    expect(extractBpmFromText("Groove 120bpm")).toBe(120);
    expect(extractBpmFromText("(120bpm)")).toBe(120);
  });

  it("matches '<n> Bpm' mixed case", () => {
    expect(extractBpmFromText("My Sample 140 Bpm")).toBe(140);
  });

  it("matches '<n>BPM' at start of name", () => {
    expect(extractBpmFromText("172BPM Drums")).toBe(172);
  });

  // ── "bpm" before number ───────────────────────────────────────────────────────

  it("matches 'BPM <n>' prefix", () => {
    expect(extractBpmFromText("BPM 98 Break")).toBe(98);
  });

  it("matches 'bpm<n>' with no space after a word boundary", () => {
    expect(extractBpmFromText("bpm120")).toBe(120);       // at start of string
    expect(extractBpmFromText("(bpm120)")).toBe(120);     // after non-word char
  });

  // ── delimiter-separated ──────────────────────────────────────────────────────

  it("matches '_<n>_' underscore delimiters", () => {
    expect(extractBpmFromText("break_98_stereo")).toBe(98);
  });

  it("matches '(<n>)' parentheses", () => {
    expect(extractBpmFromText("Conga Loop (120)")).toBe(120);
  });

  it("matches ' <n> ' space-separated in middle", () => {
    expect(extractBpmFromText("loop 140 dry")).toBe(140);
  });

  // ── filename with extension stripped ─────────────────────────────────────────

  it("matches in basename after stripping extension (as extension.ts does)", () => {
    const basename = "Aloe Vera 98 BPM.wav".replace(/\.[^.]+$/, "");
    expect(extractBpmFromText(basename)).toBe(98);
  });

  it("matches in full path basename", () => {
    const fullName = "Cosmic Vintage Drums 172 BPM";
    expect(extractBpmFromText(fullName)).toBe(172);
  });

  // ── range validation ──────────────────────────────────────────────────────────

  it("returns null for BPM below 60", () => {
    expect(extractBpmFromText("My Loop 59 BPM")).toBeNull();
  });

  it("returns null for BPM above 220", () => {
    expect(extractBpmFromText("Speedcore 221 BPM")).toBeNull();
  });

  it("accepts boundary value 60 BPM", () => {
    expect(extractBpmFromText("Slow Groove 60 BPM")).toBe(60);
  });

  it("accepts boundary value 220 BPM", () => {
    expect(extractBpmFromText("Fast Break 220 BPM")).toBe(220);
  });

  // ── no match ──────────────────────────────────────────────────────────────────

  it("returns null when no BPM pattern present", () => {
    expect(extractBpmFromText("Kick Drum Layer")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractBpmFromText("")).toBeNull();
  });

  it("returns null for name with only a bare number (ambiguous)", () => {
    // "01" or "03" track numbers shouldn't match since they're below 60
    expect(extractBpmFromText("03 Kick")).toBeNull();
  });
});
