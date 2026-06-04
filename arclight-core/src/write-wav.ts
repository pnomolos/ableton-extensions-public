import { writeFileSync } from "fs";

/**
 * Write a mono Float32Array as a 32-bit float PCM WAV file.
 */
export function writeWav(filePath: string, samples: Float32Array, sampleRate: number): void {
  const dataBytes = samples.length * 4;
  const buf = Buffer.allocUnsafe(44 + dataBytes);

  // RIFF chunk
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");

  // fmt  chunk — IEEE float (audioFormat=3), mono, 32-bit
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);           // chunk size
  buf.writeUInt16LE(3, 20);            // audioFormat: IEEE float
  buf.writeUInt16LE(1, 22);            // numChannels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); // byteRate
  buf.writeUInt16LE(4, 32);            // blockAlign
  buf.writeUInt16LE(32, 34);           // bitsPerSample

  // data chunk
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i], 44 + i * 4);
  }

  writeFileSync(filePath, buf);
}
