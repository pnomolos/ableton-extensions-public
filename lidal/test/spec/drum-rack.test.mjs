// Drum-rack introspection unit tests. Covers the exported helpers
// `escHtml` and `findFirstDrumRack` from extension.ts — the latter is the
// SDK-coupled helper we extracted so we can verify the Drum-Rack-vs-other-
// Rack discrimination without running Live.
//
// `findFirstDrumRack` takes an `ExtensionContext` + `Track` from the SDK.
// We stub both: `track.devices` returns a list of fake handles, and
// `ext.objects.getObjectFromHandle(h, cls)` consults a tag we attach to
// each fake handle to decide whether to return a "RackDevice" / throw, and
// whether the rack's chains coerce to DrumChain or plain Chain.

import { describe, it, expect } from "vitest";
import { escHtml, findFirstDrumRack } from "../../src/extension.ts";
import { RackDevice, DrumChain } from "@ableton-extensions/sdk";

// Fake handle helpers. Each "device" handle carries a `kind` and (for racks)
// an array of chain kinds: "drum" or "plain".
function makeDeviceHandle(kind, chainKinds = []) {
  return { __kind: kind, __chains: chainKinds };
}

// Fabricate a minimal ExtensionContext-shaped stub. `getObjectFromHandle`
// returns an object that proxies the chain list when asked for RackDevice,
// and either succeeds or throws when asked for DrumChain depending on the
// chain's tagged kind.
function makeFakeExt() {
  return {
    application: { song: { tracks: [] } },
    // v1.0.0 ExtensionContext exposes getObjectFromHandle directly (no `objects` namespace).
    getObjectFromHandle(handle, cls) {
      if (cls === RackDevice) {
        if (handle.__kind !== "rack") throw new Error("not a rack");
        // The "rack" we return must satisfy the iteration in
        // `isDrumRack`: it iterates `rack.chains`, each chain has a
        // `handle`. We give each chain its own handle carrying its kind.
        return {
          chains: handle.__chains.map((kind) => ({ handle: { __chainKind: kind } })),
        };
      }
      if (cls === DrumChain) {
        if (handle.__chainKind !== "drum") throw new Error("not a DrumChain");
        return { receivingNote: 36 };
      }
      throw new Error("unsupported class in test stub");
    },
  };
}

function makeTrack(deviceHandles, name = "T") {
  return {
    name,
    devices: deviceHandles.map((h) => ({ handle: h })),
  };
}

describe("escHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escHtml("Conga & Bell.aif")).toBe("Conga &amp; Bell.aif");
    expect(escHtml("<script>"))     .toBe("&lt;script&gt;");
    expect(escHtml(`"quoted"`))    .toBe("&quot;quoted&quot;");
    expect(escHtml(`it's`))         .toBe("it&#39;s");
  });

  it("does not strip the original characters (regression for issue #26)", () => {
    // Previous implementation used `.replace(/[<>&"']/g, "")` which DELETED
    // these characters. The proper escape must preserve them as entities so
    // the rendered DOM still reads "Conga & Bell.aif".
    const out = escHtml("Conga & Bell.aif");
    expect(out).toContain("&amp;");
    expect(out).not.toBe("Conga  Bell.aif");
  });

  it("escapes ampersand first to avoid double-escaping", () => {
    // If the replace order is `< > & " '` the `&` in `&lt;` from the first
    // pass would get re-escaped to `&amp;lt;`. The correct order is `&` first.
    expect(escHtml("&<")).toBe("&amp;&lt;");
  });
});

describe("findFirstDrumRack", () => {
  it("returns no-rack when the track has no devices", () => {
    const ext = makeFakeExt();
    const track = makeTrack([]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("no-rack");
  });

  it("returns no-rack when no device is a rack", () => {
    const ext = makeFakeExt();
    const track = makeTrack([
      makeDeviceHandle("synth"),
      makeDeviceHandle("eq"),
    ]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("no-rack");
  });

  it("returns drum-rack when the first rack on the chain is a Drum Rack", () => {
    const ext = makeFakeExt();
    const track = makeTrack([
      makeDeviceHandle("rack", ["drum", "drum", "drum"]),
    ]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("drum-rack");
  });

  it("returns drum-rack even when only one chain coerces to DrumChain", () => {
    // A Drum Rack may have non-DrumChain return chains. We must still
    // recognize it as a Drum Rack so long as *some* chain has a
    // receivingNote.
    const ext = makeFakeExt();
    const track = makeTrack([
      makeDeviceHandle("rack", ["plain", "drum", "plain"]),
    ]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("drum-rack");
  });

  // The TOFIX coverage gap explicitly calls out this case (#7):
  // "autoMap with Instrument-Rack-before-Drum-Rack" — previously the helper
  // silently returned the Instrument Rack and the introspection produced
  // an empty map, so the user got the misleading "no pads resolved" error.
  it("raises non-drum-rack when an Instrument Rack precedes a Drum Rack on the chain (#7)", () => {
    const ext = makeFakeExt();
    const track = makeTrack([
      makeDeviceHandle("rack", ["plain", "plain"]),   // Instrument Rack first
      makeDeviceHandle("rack", ["drum", "drum"]),     // Drum Rack second
    ]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("non-drum-rack");
    if (out.kind === "non-drum-rack") {
      expect(out.rackTypeHint).toMatch(/Instrument Rack/);
    }
  });

  it("returns non-drum-rack when the only rack is an Audio Effect Rack", () => {
    const ext = makeFakeExt();
    const track = makeTrack([
      makeDeviceHandle("rack", ["plain"]),
    ]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("non-drum-rack");
  });

  it("skips non-rack devices and finds a downstream Drum Rack", () => {
    // EQ → Reverb → Drum Rack: walking past pre-rack effects is the common
    // case (users like to send the synth output through colour first).
    const ext = makeFakeExt();
    const track = makeTrack([
      makeDeviceHandle("eq"),
      makeDeviceHandle("reverb"),
      makeDeviceHandle("rack", ["drum", "drum"]),
    ]);
    const out = findFirstDrumRack(ext, track);
    expect(out.kind).toBe("drum-rack");
  });
});
