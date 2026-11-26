// A small zip reader, so nothing extra has to be installed. It only reads (never writes) and
// opens one file at a time, so a big export never has to fit in memory. Plain zips only,
// which is what WhatsApp makes; zips over 4 GB are refused.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return n === len ? b : b.subarray(0, n); };
  const close = () => { try { fs.closeSync(fd); } catch (e) { /* already closed */ } };
  try {
    if (size < 22) throw new Error('This is not a zip file');
    const tailLen = Math.min(size, 65557);
    const tail = read(size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('This is not a zip file (or it was not fully uploaded)');
    const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('This zip is too large to read');
    const cd = read(cdOff, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const off = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      p += 46 + nl + xl + cl;
      if (name.endsWith('/') || (flags & 1)) continue;   // folders and password-protected files
      entries.push({ name, base: name.split('/').pop(), method, csize, usize, off });
    }
    // Reads one file out of the zip. maxBytes protects against files that unpack huge.
    const extract = (ent, maxBytes) => {
      if (ent.usize > maxBytes) throw new Error('file too big: ' + ent.base);
      const h = read(ent.off, 30);
      if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new Error('damaged zip');
      const start = ent.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
      const raw = read(start, ent.csize);
      if (ent.method === 0) return raw;
      if (ent.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(maxBytes, 1) });
      throw new Error('unsupported zip format');
    };
    return { entries, extract, close };
  } catch (err) { close(); throw err; }
}
