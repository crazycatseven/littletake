/** Counts the video track's samples in an MP4 (moov → trak with a 'vide' handler → stbl → stsz/stz2). WebM or fragmented files return null. */
export function mp4VideoFrameCount(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  interface Box { type: string; start: number; end: number }
  const children = (start: number, end: number): Box[] => {
    const found: Box[] = [];
    for (let offset = start; offset + 8 <= end;) {
      let size = view.getUint32(offset), header = 8;
      if (size === 1) { if (offset + 16 > end) break; size = Number(view.getBigUint64(offset + 8)); header = 16; }
      else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) break;
      found.push({ type: ascii(offset + 4), start: offset + header, end: offset + size });
      offset += size;
    }
    return found;
  };
  const child = (box: Box | undefined, type: string) => box && children(box.start, box.end).find(item => item.type === type);
  const moov = children(0, bytes.length).find(box => box.type === 'moov');
  if (!moov) return null;
  for (const trak of children(moov.start, moov.end).filter(box => box.type === 'trak')) {
    const mdia = child(trak, 'mdia'), hdlr = child(mdia, 'hdlr');
    if (!hdlr || hdlr.start + 12 > hdlr.end || ascii(hdlr.start + 8) !== 'vide') continue;
    const stbl = child(child(mdia, 'minf'), 'stbl'), sizes = child(stbl, 'stsz') ?? child(stbl, 'stz2');
    if (!sizes || sizes.start + 12 > sizes.end) return null;
    const count = view.getUint32(sizes.start + 8);
    return count > 0 ? count : null;
  }
  return null;
}
