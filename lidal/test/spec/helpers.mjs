// Shared helpers for the spec test suite.

import { expect } from "vitest";

// Default tolerance for fractional-cycle comparisons. 1e-9 is plenty tight for
// fractions like 1/3, 2/3 — Lidal's floats stay well above that noise floor.
export const EPS = 1e-9;

// Round near-integer-multiple-of-1/N fractions to clean up trailing FP noise
// so toEqual on `{ start: 1/3 }` works against `0.3333333333333333`.
export function approx(x, eps = EPS) {
  return Math.abs(x - Math.round(x)) < eps ? Math.round(x) : x;
}

// Compare two arrays of events. Each event compared on whichever subset of
// fields the expected entry specifies (extra fields on actual are ignored).
// Numeric fields are compared with EPS tolerance.
export function expectEventsMatch(actual, expected, eps = EPS) {
  expect(actual.length, `event count differs: actual=${JSON.stringify(actual)}`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    for (const k of Object.keys(e)) {
      if (typeof e[k] === "number") {
        expect(a[k], `event ${i} field "${k}" actual=${JSON.stringify(a)}`).toBeCloseTo(e[k], 9);
      } else {
        expect(a[k], `event ${i} field "${k}" actual=${JSON.stringify(a)}`).toBe(e[k]);
      }
    }
  }
}

// Sort by start ascending then by name (so chord-like events at the same start
// are compared in stable, deterministic order). The runtime always sorts by
// start; secondary by name is a test-side convenience for chord cases.
export function sortEvents(events) {
  return events.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}
