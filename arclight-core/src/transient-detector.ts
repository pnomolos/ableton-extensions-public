import { readFileSync, openSync, readSync, closeSync, fstatSync } from "fs";
import type { TransientFrame } from "./types.js";

interface WavData {
  sampleRate: number;
  numChannels: number;
  samples: Float32Array; // mono mix
  numSamples: number;
}

/** Parse a WAV file from disk into a mono float array */
// Walk RIFF chunks starting at offset 12, calling cb(id, dataOffset, dataSize) for each.
// Returns false if the file doesn't look like a RIFF/WAVE file.
function walkWavChunks(
  buf: Buffer,
  view: DataView,
  cb: (id: string, dataStart: number, dataSize: number) => boolean, // return true to stop
): void {
  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    if (cb(id, pos + 8, size)) break;
    pos += 8 + size + (size & 1); // chunks padded to even size
  }
}

// WAV audioFormat codes:  1 = PCM int, 3 = IEEE float.
// Anything else (6 = µ-law, 7 = a-law, 0xFFFE = WAVE_FORMAT_EXTENSIBLE, etc.) is unsupported.
// PCM int is only supported at 16/24-bit — 32-bit int and 8-bit unsigned require separate decoding paths.
function validateWavFormat(audioFormat: number, bitsPerSample: number): void {
  if (audioFormat === 3) {
    if (bitsPerSample !== 32) {
      throw new Error(`Unsupported WAV format: IEEE float at ${bitsPerSample}-bit (only 32-bit float is supported).`);
    }
    return;
  }
  if (audioFormat === 1) {
    if (bitsPerSample === 32) {
      throw new Error("Unsupported WAV format: 32-bit integer PCM. Please export as 32-bit float or 16-bit PCM.");
    }
    if (bitsPerSample === 8) {
      throw new Error("Unsupported WAV format: 8-bit PCM. Please export as 16-bit or 32-bit float.");
    }
    if (bitsPerSample !== 16 && bitsPerSample !== 24) {
      throw new Error(`Unsupported WAV format: ${bitsPerSample}-bit PCM. Only 16-bit and 24-bit integer PCM are supported.`);
    }
    return;
  }
  throw new Error(`Unsupported WAV format: audioFormat=${audioFormat}. Only PCM (1) and IEEE float (3) are supported.`);
}

export function parseWav(filePath: string): WavData {
  const buf = readFileSync(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let numChannels = 0, sampleRate = 0, bitsPerSample = 0, dataOffset = -1, dataSize = 0;
  let audioFormat = 0;

  walkWavChunks(buf, view, (id, start, size) => {
    if (id === "fmt ") {
      audioFormat  = view.getUint16(start, true);
      numChannels  = view.getUint16(start + 2, true);
      sampleRate   = view.getUint32(start + 4, true);
      bitsPerSample = view.getUint16(start + 14, true);
    } else if (id === "data") {
      dataOffset = start;
      dataSize   = size;
      return true;
    }
    return false;
  });

  if (dataOffset < 0 || !sampleRate || !bitsPerSample)
    throw new Error(`WAV parse failed: fmt=${!!sampleRate} data=${dataOffset >= 0} bps=${bitsPerSample}`);

  validateWavFormat(audioFormat, bitsPerSample);

  const bytesPerSample = bitsPerSample / 8;
  // Use the data chunk's declared size — NOT file size minus dataOffset, which
  // would read trailing chunks (LIST/INFO/cue/etc.) as raw audio and produce
  // garbage samples (NaN / huge floats for 32-bit format files).
  const numFrames = Math.floor(dataSize / (numChannels * bytesPerSample));
  const mono = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const off = dataOffset + (i * numChannels + ch) * bytesPerSample;
      if (bitsPerSample === 16) {
        sum += view.getInt16(off, true) / 32768;
      } else if (bitsPerSample === 24) {
        const lo = view.getUint16(off, true);
        const hi = view.getInt8(off + 2);
        sum += ((hi << 16) | lo) / 8388608;
      } else if (bitsPerSample === 32) {
        sum += view.getFloat32(off, true);
      }
    }
    mono[i] = sum / numChannels;
  }

  return { sampleRate, numChannels, samples: mono, numSamples: numFrames };
}

// Reads an IEEE 754 80-bit extended float (big-endian) — used in AIFF COMM chunk for sample rate
function read80BitFloat(view: DataView, offset: number): number {
  const exponent = (view.getUint16(offset, false) & 0x7FFF) - 16383;
  const hi = view.getUint32(offset + 2, false);
  const lo = view.getUint32(offset + 6, false);
  return (hi * 4294967296 + lo) * Math.pow(2, exponent - 63);
}

/** Parse an AIFF or AIFC file from disk into a mono float array */
export function parseAiff(filePath: string): WavData {
  const buf = readFileSync(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const form = buf.toString("ascii", 0, 4);
  const type = buf.toString("ascii", 8, 12);
  if (form !== "FORM" || (type !== "AIFF" && type !== "AIFC")) {
    throw new Error(`Not an AIFF file (FORM=${form}, type=${type})`);
  }

  let numChannels = 0, sampleRate = 0, bitDepth = 0;
  let ssndDataStart = 0;
  let commRead = false, ssndRead = false;

  let pos = 12;
  while (pos < buf.byteLength - 8) {
    const chunkId = buf.toString("ascii", pos, pos + 4);
    const chunkSize = view.getUint32(pos + 4, false); // AIFF uses big-endian

    if (chunkId === "COMM") {
      numChannels = view.getInt16(pos + 8, false);
      // numSampleFrames at pos+10 (uint32 BE) — not needed
      bitDepth = view.getInt16(pos + 14, false);
      sampleRate = Math.round(read80BitFloat(view, pos + 16));
      // AIFC files carry an extra 4-byte OSType compressionType starting 18 bytes
      // into the COMM data (after 2+4+2+10 bytes). Plain AIFF files don't have
      // this field — they're always uncompressed PCM.
      if (type === "AIFC" && chunkSize >= 22) {
        const commStart = pos + 8;
        const compressionType = String.fromCharCode(
          view.getUint8(commStart + 18),
          view.getUint8(commStart + 19),
          view.getUint8(commStart + 20),
          view.getUint8(commStart + 21),
        );
        if (compressionType !== "NONE") {
          throw new Error(`Unsupported AIFC compression: '${compressionType}'. Only uncompressed AIFC (NONE) is supported.`);
        }
      }
      commRead = true;
    } else if (chunkId === "SSND") {
      const dataOffset = view.getUint32(pos + 8, false); // extra offset inside SSND
      ssndDataStart = pos + 16 + dataOffset; // 8 (chunk hdr) + 8 (offset+blockSize fields) + dataOffset
      ssndRead = true;
    }

    pos += 8 + chunkSize + (chunkSize & 1); // AIFF pads chunks to even size
    if (commRead && ssndRead) break;
  }

  if (!commRead || !ssndRead) throw new Error("AIFF: missing COMM or SSND chunk");
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new Error(`AIFF: unsupported bit depth ${bitDepth}`);
  }

  const bytesPerSample = bitDepth / 8;
  const available = buf.byteLength - ssndDataStart;
  const numFrames = Math.floor(available / (numChannels * bytesPerSample));
  const mono = new Float32Array(numFrames);
  const sdView = new DataView(buf.buffer, buf.byteOffset + ssndDataStart, available);

  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const off = (i * numChannels + ch) * bytesPerSample;
      if (bitDepth === 16) {
        sum += sdView.getInt16(off, false) / 32768; // AIFF is big-endian
      } else if (bitDepth === 24) {
        const hi8 = sdView.getInt8(off);
        const mid8 = sdView.getUint8(off + 1);
        const lo8 = sdView.getUint8(off + 2);
        sum += ((hi8 << 16) | (mid8 << 8) | lo8) / 8388608;
      } else {
        sum += sdView.getFloat32(off, false); // 32-bit float, big-endian
      }
    }
    mono[i] = sum / numChannels;
  }

  return { sampleRate, numChannels, samples: mono, numSamples: numFrames };
}

/** Parse a WAV or AIFF/AIF file from disk into a mono float array */
export function parseAudio(filePath: string): WavData {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "aif" || ext === "aiff") return parseAiff(filePath);
  return parseWav(filePath);
}

// ── Biquad filter helpers (RBJ Audio EQ Cookbook) ────────────────────────────

function applyBiquad(
  samples: Float32Array,
  b0: number, b1: number, b2: number,
  a1: number, a2: number,
): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

function applyLowpass(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const w0 = 2 * Math.PI * cutoffHz / sampleRate;
  const alpha = Math.sin(w0) / (2 * 0.707); // Butterworth Q
  const cosW = Math.cos(w0);
  const a0 = 1 + alpha;
  return applyBiquad(samples,
    (1 - cosW) / 2 / a0,
    (1 - cosW) / a0,
    (1 - cosW) / 2 / a0,
    -2 * cosW / a0,
    (1 - alpha) / a0,
  );
}

function applyHighpass(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const w0 = 2 * Math.PI * cutoffHz / sampleRate;
  const alpha = Math.sin(w0) / (2 * 0.707);
  const cosW = Math.cos(w0);
  const a0 = 1 + alpha;
  return applyBiquad(samples,
    (1 + cosW) / 2 / a0,
    -(1 + cosW) / a0,
    (1 + cosW) / 2 / a0,
    -2 * cosW / a0,
    (1 - alpha) / a0,
  );
}

/**
 * Apply a bandpass filter isolating the given frequency range.
 * kick: lowpass at highHz; hihat: highpass at lowHz; snare: bandpass.
 * Returns a new Float32Array — does not modify the input.
 */
export function applyBandpassFilter(
  samples: Float32Array,
  sampleRate: number,
  lowHz: number,
  highHz: number,
): Float32Array {
  const nyquist = sampleRate / 2;
  if (lowHz <= 20 && highHz >= nyquist) return samples;
  // skip HP below 20 Hz — effectively DC; caller should pass lowHz > 20 for true bandpass
  if (lowHz <= 20) return applyLowpass(samples, sampleRate, Math.min(highHz, nyquist * 0.95));
  if (highHz >= nyquist) return applyHighpass(samples, sampleRate, lowHz);

  // Bandpass: cascade lowpass + highpass
  const lp = applyLowpass(samples, sampleRate, Math.min(highHz, nyquist * 0.95));
  return applyHighpass(lp, sampleRate, lowHz);
}

export interface TransientDetectionOptions {
  /** Hop size in samples between analysis frames (default: 512) */
  hopSize?: number;
  /** FFT/window size in samples (default: 1024) */
  windowSize?: number;
  /** Detection threshold as fraction of max flux (default: 0.3) */
  threshold?: number;
  /** Min gap between onsets in seconds (default: 0.05) */
  minGapSeconds?: number;
  /** Beats per minute, used to compute timeBeat (default: 120) */
  bpm?: number;
}

// In-place radix-2 Cooley-Tukey FFT (N must be a power of 2).
// Replaces the O(N²) naive DFT — ~16× faster for N=256, ~85× for N=1024.
export function fft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  // Bit-reverse permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly stages
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wBaseRe = Math.cos(ang), wBaseIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < N; i += len) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k],       uIm = im[i + k];
        const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
        const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe;
        re[i + k]        = uRe + vRe;  im[i + k]        = uIm + vIm;
        re[i + k + half] = uRe - vRe;  im[i + k + half] = uIm - vIm;
        const tmp = wRe * wBaseRe - wIm * wBaseIm;
        wIm = wRe * wBaseIm + wIm * wBaseRe;
        wRe = tmp;
      }
    }
  }
}

/** Detect transients using spectral flux onset detection */
export function detectTransients(wav: WavData, opts: TransientDetectionOptions = {}): TransientFrame[] {
  const {
    hopSize = 512,
    windowSize = 1024,
    threshold = 0.3,
    minGapSeconds = 0.05,
    bpm = 120,
  } = opts;

  const { samples, sampleRate } = wav;
  const numFrames = Math.floor((samples.length - windowSize) / hopSize);
  const prevSpectrum = new Float32Array(windowSize / 2);
  const fluxValues: number[] = [];

  // Pre-compute Hann window coefficients and reusable FFT buffers
  const hann = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
  }
  const fftRe = new Float32Array(windowSize);
  const fftIm = new Float32Array(windowSize);

  // Compute spectral flux for each frame
  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * hopSize;

    // Apply Hann window into FFT input buffer
    for (let i = 0; i < windowSize; i++) {
      fftRe[i] = samples[offset + i] * hann[i];
      fftIm[i] = 0;
    }

    fft(fftRe, fftIm);

    // Half-wave rectified spectral flux on positive bins
    let flux = 0;
    for (let k = 0; k < windowSize / 2; k++) {
      const mag = Math.sqrt(fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k]) / windowSize;
      const diff = mag - prevSpectrum[k];
      if (diff > 0) flux += diff;
      prevSpectrum[k] = mag;
    }
    fluxValues.push(flux);
  }

  // Normalize flux — avoid spread-arg stack overflow on long audio (>~100k frames)
  let maxFlux = 1e-10;
  for (const v of fluxValues) if (v > maxFlux) maxFlux = v;
  const normalizedFlux = fluxValues.map(f => f / maxFlux);

  // Pick peaks above threshold with minimum gap
  const minGapFrames = Math.ceil((minGapSeconds * sampleRate) / hopSize);
  const transients: TransientFrame[] = [];
  let lastOnsetFrame = -minGapFrames;

  const halfWindow = Math.floor(windowSize / 2);
  for (let i = 1; i < normalizedFlux.length - 1; i++) {
    if (
      normalizedFlux[i] > threshold &&
      normalizedFlux[i] > normalizedFlux[i - 1] &&
      normalizedFlux[i] >= normalizedFlux[i + 1] &&
      i - lastOnsetFrame >= minGapFrames
    ) {
      // Report the center of the analysis window — the spectral event captured
      // in the flux frame is centered at frame * hopSize + windowSize / 2, not
      // at the window start. Reporting the start introduces a systematic bias.
      const sampleIndex = i * hopSize + halfWindow;
      const timeSeconds = sampleIndex / sampleRate;
      const timeBeat = (timeSeconds / 60) * bpm;
      transients.push({ sampleIndex, timeSeconds, timeBeat, strength: normalizedFlux[i] });
      lastOnsetFrame = i;
    }
  }

  return transients;
}

/**
 * Detect transients using the SuperFlux algorithm (Böck & Widmer, DAFx-13).
 *
 * Like {@link detectTransients}, but instead of comparing each magnitude bin to
 * the same bin in the previous frame, it compares to the **maximum magnitude
 * in a small frequency neighborhood** of the previous frame. This suppresses
 * false detections from spectral wandering (e.g. vibrato / pitch drift) which
 * the naive flux would otherwise see as repeated onsets.
 *
 * `maxFilterWidth` is the half-width of the local-max neighborhood (in bins).
 * Default 3 — i.e. compare each bin to the max over [k-3, k+3] of the prev frame.
 */
export function detectTransientsSuperFlux(
  wav: WavData,
  opts: TransientDetectionOptions & { maxFilterWidth?: number } = {},
): TransientFrame[] {
  const {
    hopSize = 512,
    windowSize = 1024,
    threshold = 0.2,
    minGapSeconds = 0.05,
    bpm = 120,
    maxFilterWidth = 3,
  } = opts;

  const { samples, sampleRate } = wav;
  const numFrames = Math.floor((samples.length - windowSize) / hopSize);
  if (numFrames < 2) return [];

  const numBins = windowSize / 2;
  const prevSpectrum = new Float32Array(numBins);
  const fluxValues: number[] = [];

  // Pre-compute Hann window coefficients and reusable FFT buffers
  const hann = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
  }
  const fftRe = new Float32Array(windowSize);
  const fftIm = new Float32Array(windowSize);
  const curMag = new Float32Array(numBins);

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * hopSize;

    for (let i = 0; i < windowSize; i++) {
      fftRe[i] = samples[offset + i] * hann[i];
      fftIm[i] = 0;
    }
    fft(fftRe, fftIm);

    for (let k = 0; k < numBins; k++) {
      curMag[k] = Math.sqrt(fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k]) / windowSize;
    }

    // SuperFlux: subtract the local max in the previous frame's neighborhood.
    // Use a logarithmic compression so quiet onsets register but loud sustained
    // tones don't dominate. log(1 + C * x) keeps small magnitudes near 0.
    let flux = 0;
    if (frame > 0) {
      for (let k = 0; k < numBins; k++) {
        let prevMax = 0;
        const lo = Math.max(0, k - maxFilterWidth);
        const hi = Math.min(numBins - 1, k + maxFilterWidth);
        for (let j = lo; j <= hi; j++) {
          if (prevSpectrum[j] > prevMax) prevMax = prevSpectrum[j];
        }
        const diff = Math.log(1 + 1000 * curMag[k]) - Math.log(1 + 1000 * prevMax);
        if (diff > 0) flux += diff;
      }
    }
    fluxValues.push(flux);

    // Save current spectrum for next frame
    for (let k = 0; k < numBins; k++) prevSpectrum[k] = curMag[k];
  }

  // Normalize flux to [0, 1]
  let maxFlux = 1e-10;
  for (const f of fluxValues) if (f > maxFlux) maxFlux = f;
  const normalizedFlux = fluxValues.map(f => f / maxFlux);

  // Peak picking with moving-max local threshold (SuperFlux paper recommends this).
  // A peak must be (a) above the global threshold, (b) a local max, and (c) above
  // the local mean by a small margin.  We approximate with simple local-max + gap.
  const minGapFrames = Math.ceil((minGapSeconds * sampleRate) / hopSize);
  const transients: TransientFrame[] = [];
  let lastOnsetFrame = -minGapFrames;

  const halfWindow = Math.floor(windowSize / 2);
  for (let i = 1; i < normalizedFlux.length - 1; i++) {
    if (
      normalizedFlux[i] > threshold &&
      normalizedFlux[i] > normalizedFlux[i - 1] &&
      normalizedFlux[i] >= normalizedFlux[i + 1] &&
      i - lastOnsetFrame >= minGapFrames
    ) {
      // Report the center of the analysis window — the spectral event captured
      // in the flux frame is centered at frame * hopSize + windowSize / 2, not
      // at the window start.
      const sampleIndex = i * hopSize + halfWindow;
      const timeSeconds = sampleIndex / sampleRate;
      const timeBeat = (timeSeconds / 60) * bpm;
      transients.push({ sampleIndex, timeSeconds, timeBeat, strength: normalizedFlux[i] });
      lastOnsetFrame = i;
    }
  }

  return transients;
}

// ── Partial file readers ──────────────────────────────────────────────────────
// These read only the first N seconds from a WAV or AIFF file using fd+readSync,
// so large files are never fully loaded into memory.

function parseWavPartial(filePath: string, maxSeconds: number): WavData {
  const HEADER_READ = 1024;
  const hdrBuf = Buffer.alloc(HEADER_READ);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, hdrBuf, 0, HEADER_READ, 0);
    const view = new DataView(hdrBuf.buffer, hdrBuf.byteOffset, HEADER_READ);

    let numChannels = 0, sampleRate = 0, bitsPerSample = 0, dataOffset = -1;
    let audioFormat = 0;
    let pos = 12;
    while (pos + 8 <= HEADER_READ) {
      const id = hdrBuf.toString("ascii", pos, pos + 4);
      const sz = view.getUint32(pos + 4, true);
      if (id === "fmt ") {
        audioFormat   = view.getUint16(pos + 8, true);
        numChannels   = view.getUint16(pos + 10, true);
        sampleRate    = view.getUint32(pos + 12, true);
        bitsPerSample = view.getUint16(pos + 22, true);
      } else if (id === "data") {
        dataOffset = pos + 8;
        break;
      }
      pos += 8 + sz + (sz & 1);
    }

    if (dataOffset < 0 || !sampleRate || !bitsPerSample)
      throw new Error(`WAV parse failed: fmt=${!!sampleRate} data=${dataOffset >= 0} bps=${bitsPerSample}`);

    validateWavFormat(audioFormat, bitsPerSample);

    const bytesPerSample = bitsPerSample / 8;
    const maxBytes  = Math.round(maxSeconds * sampleRate) * numChannels * bytesPerSample;
    const fileBytes = fstatSync(fd).size - dataOffset;
    const toRead    = Math.min(maxBytes, fileBytes);

    const dataBuf = Buffer.alloc(toRead);
    readSync(fd, dataBuf, 0, toRead, dataOffset);

    const numFrames = Math.floor(toRead / (numChannels * bytesPerSample));
    const mono = new Float32Array(numFrames);
    const dv = new DataView(dataBuf.buffer, dataBuf.byteOffset, toRead);

    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const off = (i * numChannels + ch) * bytesPerSample;
        if (bitsPerSample === 16) {
          sum += dv.getInt16(off, true) / 32768;
        } else if (bitsPerSample === 24) {
          sum += (((dv.getInt8(off + 2) << 16) | (dv.getUint8(off + 1) << 8) | dv.getUint8(off)) / 8388608);
        } else {
          sum += dv.getFloat32(off, true);
        }
      }
      mono[i] = sum / numChannels;
    }
    return { sampleRate, numChannels, samples: mono, numSamples: numFrames };
  } finally {
    closeSync(fd);
  }
}

function parseAiffPartial(filePath: string, maxSeconds: number): WavData {
  const HEADER_READ = 1024;
  const hdrBuf = Buffer.alloc(HEADER_READ);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, hdrBuf, 0, HEADER_READ, 0);
    const view = new DataView(hdrBuf.buffer, hdrBuf.byteOffset, HEADER_READ);

    const formType = hdrBuf.toString("ascii", 8, 12);

    let numChannels = 0, sampleRate = 0, bitsPerSample = 0, ssndDataStart = 0;
    let pos = 12;
    while (pos < HEADER_READ - 8) {
      const id = hdrBuf.toString("ascii", pos, pos + 4);
      const sz = view.getUint32(pos + 4, false);
      if (id === "COMM") {
        numChannels  = view.getInt16(pos + 8, false);
        bitsPerSample = view.getInt16(pos + 14, false);
        sampleRate   = Math.round(read80BitFloat(view, pos + 16));
        if (formType === "AIFC" && sz >= 22) {
          const commStart = pos + 8;
          const compressionType = String.fromCharCode(
            view.getUint8(commStart + 18),
            view.getUint8(commStart + 19),
            view.getUint8(commStart + 20),
            view.getUint8(commStart + 21),
          );
          if (compressionType !== "NONE") {
            throw new Error(`Unsupported AIFC compression: '${compressionType}'. Only uncompressed AIFC (NONE) is supported.`);
          }
        }
      } else if (id === "SSND") {
        ssndDataStart = pos + 16 + view.getUint32(pos + 8, false);
      }
      pos += 8 + sz + (sz & 1);
      if (numChannels && sampleRate && ssndDataStart) break;
    }

    const bytesPerSample = bitsPerSample / 8;
    const maxBytes  = Math.round(maxSeconds * sampleRate) * numChannels * bytesPerSample;
    const fileBytes = fstatSync(fd).size - ssndDataStart;
    const toRead    = Math.min(maxBytes, fileBytes);

    const dataBuf = Buffer.alloc(toRead);
    readSync(fd, dataBuf, 0, toRead, ssndDataStart);

    const numFrames = Math.floor(toRead / (numChannels * bytesPerSample));
    const mono = new Float32Array(numFrames);
    const dv = new DataView(dataBuf.buffer, dataBuf.byteOffset, toRead);

    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const off = (i * numChannels + ch) * bytesPerSample;
        if (bitsPerSample === 16) {
          sum += dv.getInt16(off, false) / 32768;
        } else if (bitsPerSample === 24) {
          sum += (((dv.getInt8(off) << 16) | (dv.getUint8(off + 1) << 8) | dv.getUint8(off + 2)) / 8388608);
        } else {
          sum += dv.getFloat32(off, false);
        }
      }
      mono[i] = sum / numChannels;
    }
    return { sampleRate, numChannels, samples: mono, numSamples: numFrames };
  } finally {
    closeSync(fd);
  }
}

function parseAudioPartial(filePath: string, maxSeconds: number): WavData {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "aif" || ext === "aiff") return parseAiffPartial(filePath, maxSeconds);
  return parseWavPartial(filePath, maxSeconds);
}

/**
 * Estimate the tempo of an audio file via autocorrelation of the onset strength function.
 *
 * Builds a 100 fps onset envelope from spectral flux transients, then autocorrelates it
 * over the 60–200 BPM range. The lag with the highest normalized correlation is the beat
 * period. If a correlation at double the tempo is nearly as strong (≥85%), the higher BPM
 * is preferred — this resolves the common half-tempo ambiguity in drum loops.
 *
 * Returns { bpm, confidence } where confidence is 0–1. Values below ~0.1 mean the audio
 * has no clear rhythmic pulse; callers should treat the BPM as a suggestion only.
 */
export function estimateTempo(filePath: string): { bpm: number; confidence: number } {
  // Read only the first 8 seconds — never loads the full file into memory
  const wav = parseAudioPartial(filePath, 8);

  const transients = detectTransients(wav, {
    threshold: 0.15,
    minGapSeconds: 0.04,
    windowSize: 256,
    hopSize: 128,
  });

  if (transients.length < 4) return { bpm: 120, confidence: 0 };

  // Build onset strength function at 100 fps
  const FPS = 100;
  const duration = wav.numSamples / wav.sampleRate;
  const numFrames = Math.ceil(duration * FPS);
  const onset = new Float32Array(numFrames);
  for (const t of transients) {
    const frame = Math.min(Math.round(t.timeSeconds * FPS), numFrames - 1);
    onset[frame] += t.strength;
  }

  // Autocorrelate over 60–200 BPM (lag range: 30–100 frames at 100 fps)
  const minLag = 30;  // 200 BPM → 0.300s
  const maxLag = 100; // 60 BPM  → 1.000s
  const corr = new Float32Array(maxLag + 1);

  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = numFrames - lag;
    for (let i = 0; i < n; i++) sum += onset[i] * onset[i + lag];
    corr[lag] = sum / n;
    if (corr[lag] > bestCorr) { bestCorr = corr[lag]; bestLag = lag; }
  }

  // Confidence: correlation at best lag relative to zero-lag (self-correlation)
  let selfCorr = 0;
  for (let i = 0; i < numFrames; i++) selfCorr += onset[i] * onset[i];
  selfCorr /= numFrames;
  const confidence = selfCorr > 0 ? Math.min(1, bestCorr / selfCorr) : 0;

  // Double-tempo check: if lag/2 is in range and nearly as strong, prefer the faster BPM.
  // This resolves half-bar vs quarter-note ambiguity — the narrower grid is more useful.
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag && halfLag <= maxLag && corr[halfLag] >= bestCorr * 0.85) {
    bestLag = halfLag;
  }

  // Parabolic interpolation for sub-frame lag accuracy (recovers ~0.5 BPM precision).
  let trueLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = corr[bestLag - 1], b = corr[bestLag], c = corr[bestLag + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-10) trueLag += 0.5 * (a - c) / denom;
  }

  const bpm = Math.round((60 * FPS / trueLag) * 10) / 10;
  return { bpm, confidence };
}
