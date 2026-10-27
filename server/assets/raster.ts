import { deflateSync } from 'node:zlib';

type Point = { x: number; y: number; z: number };

/** Orthographic triangle coverage with a depth test at each pixel, independent of draw order. */
export function rasterTriangle(pixels: Uint8Array, depth: Float64Array, width: number, height: number, triangle: Point[], rgb: number[]) {
  const [a, b, c] = triangle;
  const edge = (u: Point, v: Point, x: number, y: number) => (v.x - u.x) * (y - u.y) - (v.y - u.y) * (x - u.x);
  const area = edge(a, b, c.x, c.y);
  if (Math.abs(area) < 1e-10) return;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const u = edge(b, c, x + .5, y + .5) / area, v = edge(c, a, x + .5, y + .5) / area, w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    const z = u * a.z + v * b.z + w * c.z, index = y * width + x;
    if (z >= depth[index]) continue;
    depth[index] = z;
    pixels.set([...rgb, 255], index * 4);
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type: string, data: Uint8Array) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(type, 4); output.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

/** Encode opaque RGBA after averaging the 2x samples used by the preview. */
export function encodePreviewPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 4; channel++) {
    const at = ((y * 2) * width * 2 + x * 2) * 4 + channel;
    scanlines[y * (width * 4 + 1) + 1 + x * 4 + channel] = Math.round((pixels[at] + pixels[at + 4] + pixels[at + width * 8] + pixels[at + width * 8 + 4]) / 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
