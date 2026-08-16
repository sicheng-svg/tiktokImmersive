import { readFile, writeFile } from "node:fs/promises";
import lamejs from "@breezystack/lamejs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/encode-test-audio.mjs <input.wav> <output.mp3>");
}

const wav = await readFile(inputPath);
if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
  throw new Error("Input is not a RIFF/WAVE file");
}

let offset = 12;
let format;
let pcm;
while (offset + 8 <= wav.length) {
  const chunkId = wav.toString("ascii", offset, offset + 4);
  const chunkSize = wav.readUInt32LE(offset + 4);
  const chunkStart = offset + 8;
  if (chunkId === "fmt ") {
    format = {
      audioFormat: wav.readUInt16LE(chunkStart),
      channels: wav.readUInt16LE(chunkStart + 2),
      sampleRate: wav.readUInt32LE(chunkStart + 4),
      bitsPerSample: wav.readUInt16LE(chunkStart + 14),
    };
  } else if (chunkId === "data") {
    pcm = wav.subarray(chunkStart, chunkStart + chunkSize);
  }
  offset = chunkStart + chunkSize + (chunkSize % 2);
}

if (!format || !pcm) throw new Error("WAVE file is missing fmt or data chunks");
if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
  throw new Error("Expected 16-bit mono PCM audio");
}

const samples = new Int16Array(pcm.length / 2);
for (let index = 0; index < samples.length; index += 1) {
  samples[index] = pcm.readInt16LE(index * 2);
}

const encoder = new lamejs.Mp3Encoder(1, format.sampleRate, 96);
const chunks = [];
for (let start = 0; start < samples.length; start += 1152) {
  const chunk = encoder.encodeBuffer(samples.subarray(start, start + 1152));
  if (chunk.length > 0) chunks.push(Buffer.from(chunk));
}
const finalChunk = encoder.flush();
if (finalChunk.length > 0) chunks.push(Buffer.from(finalChunk));
await writeFile(outputPath, Buffer.concat(chunks));
