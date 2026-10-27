// Reads a pzstd-style .zst file frame by frame. Lichess writes a skippable
// frame before every real frame, holding that frame's compressed size; Node's
// own zstd stream stops after the first frame, so the frames are walked here.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

function isSkippable(magic) {
  return (magic & 0xfffffff0) === 0x184d2a50;
}

// Yields each frame's decompressed bytes.
export function* zstdFrames(path) {
  const data = readFileSync(path);
  let at = 0;
  let nextLength = null;
  while (at + 4 <= data.length) {
    const magic = data.readUInt32LE(at);
    if (isSkippable(magic)) {
      const size = data.readUInt32LE(at + 4);
      nextLength = size === 4 ? data.readUInt32LE(at + 8) : null;
      at += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`no zstd frame at byte ${at}`);
    if (nextLength === null) {
      // A last frame without a size hint runs to the end of the file.
      yield zstdDecompressSync(data.subarray(at));
      return;
    }
    yield zstdDecompressSync(data.subarray(at, at + nextLength));
    at += nextLength;
    nextLength = null;
  }
}

// Yields text lines, carrying a line split across two frames.
export function* frameLines(path) {
  let carry = '';
  for (const frame of zstdFrames(path)) {
    const text = carry + frame.toString('utf8');
    const parts = text.split('\n');
    carry = parts.pop();
    for (const line of parts) yield line;
  }
  if (carry) yield carry;
}
