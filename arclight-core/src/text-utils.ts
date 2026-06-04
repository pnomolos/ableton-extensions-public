/**
 * Extract a BPM value from a clip name or filename.
 *
 * Matches common sample-pack conventions:
 *   "98 BPM", "120bpm", "BPM 172", "_98_", "(100bpm)", "My Loop 140 Bpm.wav"
 *
 * Returns null if no credible BPM (60–220) is found.
 */
export function extractBpmFromText(text: string): number | null {
  const patterns = [
    /\b(\d{2,3})\s*bpm\b/i,  // "98 BPM", "120bpm", "140 Bpm"
    /\bbpm\s*(\d{2,3})\b/i,  // "BPM 98", "bpm120"
    /[_\s(](\d{2,3})[_\s)]/,  // "_98_", " 98 ", "(98)"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const bpm = parseInt(m[1], 10);
      if (bpm >= 60 && bpm <= 220) return bpm;
    }
  }
  return null;
}
