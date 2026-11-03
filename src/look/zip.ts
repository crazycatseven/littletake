/** A minimal stored (uncompressed) ZIP writer: images and WebM are already compressed. */
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder(), parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number, write: (view: DataView) => void) => { const bytes = new Uint8Array(size); write(new DataView(bytes.buffer)); return bytes; };
  for (const file of files) {
    const name = encoder.encode(file.name), crc = crc32(file.data), size = file.data.length;
    // Version 20, UTF-8 names (bit 11), stored, DOS date 1980-01-01.
    const common = (view: DataView, at: number) => { view.setUint16(at, 20, true); view.setUint16(at + 2, 0x0800, true); view.setUint16(at + 4, 0, true); view.setUint16(at + 6, 0, true); view.setUint16(at + 8, 33, true); view.setUint32(at + 10, crc, true); view.setUint32(at + 14, size, true); view.setUint32(at + 18, size, true); view.setUint16(at + 22, name.length, true); };
    const local = header(30, view => { view.setUint32(0, 0x04034b50, true); common(view, 4); });
    parts.push(local, name, file.data);
    central.push(header(46, view => { view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); common(view, 6); view.setUint32(42, offset, true); }), name);
    offset += local.length + name.length + size;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, view => { view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, directorySize, true); view.setUint32(16, offset, true); });
  const all = [...parts, ...central, end], output = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) { output.set(part, at); at += part.length; }
  return output;
}

/** Read the stored ZIP format used by project archives and video packages. */
export async function readZip(blob: Blob, maxBytes: number, maxEntryBytes: number): Promise<Map<string, Uint8Array>> {
  if (blob.size > maxBytes) throw new Error('This archive is too large.');
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), files = new Map<string, Uint8Array>(), decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true), method = view.getUint16(offset + 8, true), size = view.getUint32(offset + 18, true), original = view.getUint32(offset + 22, true), nameSize = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    if (method !== 0 || flags & 9 || size !== original || size > maxEntryBytes) throw new Error('Choose a complete LittleTake archive.');
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameSize)), start = offset + 30 + nameSize + extra;
    if (start + size > bytes.length || files.has(name)) throw new Error('This archive is incomplete or corrupt.');
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== view.getUint32(offset + 14, true)) throw new Error('This archive is corrupt.');
    files.set(name, data); offset = start + size;
  }
  const end = bytes.length - 22;
  if (!files.size || end < offset || view.getUint32(offset, true) !== 0x02014b50 || view.getUint32(end, true) !== 0x06054b50 || view.getUint32(end + 16, true) !== offset || view.getUint32(end + 12, true) !== end - offset || view.getUint16(end + 10, true) !== files.size)
    throw new Error('This archive is incomplete or corrupt.');
  return files;
}
