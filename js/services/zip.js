(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Minimal store-only ZIP writer (v3-Lite §8). No compression is used so the
   * output is deterministic and works offline in every browser; the files are
   * accounting exports (already compact text), not photos. Arabic file
   * contents are UTF-8 and filenames set the UTF-8 flag (bit 11).
   */

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }

  function crc32(bytes) {
    const table = crcTable();
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(String(text == null ? '' : text));
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function dosDateTime(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const year = Math.max(1980, d.getFullYear());
    return {
      time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) |
        (Math.floor(d.getSeconds() / 2) & 0x1F),
      date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) |
        (d.getDate() & 0x1F),
    };
  }

  class ByteWriter {
    constructor() {
      this.chunks = [];
      this.length = 0;
    }
    bytes(arr) {
      const data = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
      this.chunks.push(data);
      this.length += data.length;
      return this;
    }
    u16(value) {
      return this.bytes([value & 0xFF, (value >>> 8) & 0xFF]);
    }
    u32(value) {
      return this.bytes([value & 0xFF, (value >>> 8) & 0xFF,
        (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]);
    }
    ascii(text) {
      const data = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i) & 0xFF;
      return this.bytes(data);
    }
    toUint8Array() {
      const out = new Uint8Array(this.length);
      let offset = 0;
      for (const chunk of this.chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    }
  }

  class ZipWriter {
    constructor(options) {
      const opts = options || {};
      this.entries = [];
      this.date = opts.date ? new Date(opts.date) : new Date();
      this.comment = opts.comment || '';
    }

    add(name, data, options) {
      const opts = options || {};
      const filename = String(name || '').replace(/\\/g, '/');
      if (!filename || filename.startsWith('/') || filename.indexOf('../') !== -1) {
        throw new Error('اسم ملف غير صالح داخل الحزمة: ' + filename);
      }
      const bytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
      const d = opts.date ? new Date(opts.date) : this.date;
      this.entries.push({
        name: filename,
        nameBytes: utf8(filename),
        data: bytes,
        crc: crc32(bytes),
        date: dosDateTime(d),
      });
      return this;
    }

    addJson(name, value) {
      return this.add(name, JSON.stringify(value, null, 2));
    }

    generate() {
      const out = new ByteWriter();
      const central = [];
      for (const entry of this.entries) {
        const offset = out.length;
        const name = entry.nameBytes;
        out.u32(0x04034B50);
        out.u16(20);              // version needed
        out.u16(0x0800);          // UTF-8 filename
        out.u16(0);               // stored
        out.u16(entry.date.time);
        out.u16(entry.date.date);
        out.u32(entry.crc);
        out.u32(entry.data.length);
        out.u32(entry.data.length);
        out.u16(name.length);
        out.u16(0);
        out.bytes(name);
        out.bytes(entry.data);
        central.push({ entry, offset });
      }
      const cdStart = out.length;
      for (const row of central) {
        const entry = row.entry;
        const name = entry.nameBytes;
        out.u32(0x02014B50);
        out.u16(20);              // version made by
        out.u16(20);              // version needed
        out.u16(0x0800);
        out.u16(0);
        out.u16(entry.date.time);
        out.u16(entry.date.date);
        out.u32(entry.crc);
        out.u32(entry.data.length);
        out.u32(entry.data.length);
        out.u16(name.length);
        out.u16(0);               // extra
        out.u16(0);               // comment
        out.u16(0);               // disk
        out.u16(0);               // internal attrs
        out.u32(0);               // external attrs
        out.u32(row.offset);
        out.bytes(name);
      }
      const cdSize = out.length - cdStart;
      out.u32(0x06054B50);
      out.u16(0);
      out.u16(0);
      out.u16(central.length);
      out.u16(central.length);
      out.u32(cdSize);
      out.u32(cdStart);
      const comment = utf8(this.comment);
      out.u16(comment.length);
      out.bytes(comment);
      return out.toUint8Array();
    }

    async blob() {
      return new Blob([this.generate()], { type: 'application/zip' });
    }
  }

  /**
   * Reads the stored entries back (tests and package self-checks). Only the
   * store method is supported, which is exactly what this writer produces.
   * @param {Uint8Array|ArrayBuffer} input zip bytes
   * @returns {Array<{name:string,data:Uint8Array,crc:number}>}
   */
  function readEntries(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const earliest = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= earliest; i--) {
      if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ملف ZIP غير صالح');
    const count = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const out = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014B50) throw new Error('فهرس ZIP تالف');
      const method = view.getUint16(p + 10, true);
      if (method !== 0) throw new Error('طريقة ضغط غير مدعومة في ملف ZIP');
      const crc = view.getUint32(p + 16, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = utf8Decode(bytes.slice(p + 46, p + 46 + nameLen));
      if (view.getUint32(localOffset, true) !== 0x04034B50) throw new Error('ترويسة ZIP تالفة');
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = bytes.slice(dataStart, dataStart + size);
      if (crc32(data) !== crc) throw new Error('تحقق CRC فشل للملف ' + name);
      out.push({ name, data, crc });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function create(files, options) {
    const zip = new ZipWriter(options);
    for (const file of (files || [])) zip.add(file.name, file.data, file);
    return zip.generate();
  }

  BeeStore.zip = { ZipWriter, crc32, create, readEntries, utf8, utf8Decode };
  if (typeof module !== 'undefined') module.exports = BeeStore.zip;
})(typeof window !== 'undefined' ? window : globalThis);
