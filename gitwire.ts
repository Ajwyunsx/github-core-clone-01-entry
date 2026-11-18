// pkt-line framing and the git packfile format: the two encodings git's smart HTTP speaks.
//
// pkt-line: a 4-digit hex length (the four bytes included) followed by the payload. `0000` is a
// flush, `0001` a delimiter, `0002` a response end. Everything on the wire — advertisements,
// command lists, report-status — is a sequence of these.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import type { GitObject, ObjectType } from './store.ts';

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** One pkt-line: the length prefix plus the payload. */
export function pkt(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload ${body.length} exceeds the 65516-byte maximum`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export type PktItem = Buffer | string | 'flush' | 'delim' | 'end';

/** A run of pkt-lines, with the control packets spelled as strings. */
export function pktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else if (item === 'end') parts.push(RESPONSE_END);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

export type PacketKind = 'data' | 'flush' | 'delim' | 'end';

export interface Packet {
  readonly kind: PacketKind;
  readonly payload: Buffer;
}

/** Decode a whole pkt-line stream. Throws when a length prefix is not hex or overruns the buffer. */
export function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    offset += 4;
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      continue;
    }
    if (length < 4 || offset + length - 4 > buf.length) throw new Error(`pkt-line length ${length} overruns the body`);
    out.push({ kind: 'data', payload: buf.subarray(offset, offset + length - 4) });
    offset += length - 4;
  }
  return out;
}

// ---------------------------------------------------------------- objects

/** A git object's id: SHA-1 over `<type> <size>\0<bytes>`. */
export function oidOf(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\u0000`, 'utf8').update(data).digest('hex');
}

/** The type and payload a commit header names, without trusting the caller. */
export function parseObjectHeader(buf: Buffer): { type: ObjectType; size: number } | null {
  const nul = buf.indexOf(0);
  if (nul < 0) return null;
  const header = buf.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space < 0) return null;
  const type = header.slice(0, space) as ObjectType;
  if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') return null;
  const size = Number(header.slice(space + 1));
  if (!Number.isFinite(size)) return null;
  return { type, size };
}

/** The `object <oid>` line of a tag, or null when the payload is not a tag. */
export function tagTarget(data: Buffer): string | null {
  if (!data.subarray(0, 7).toString('latin1').startsWith('object ')) return null;
  const end = data.indexOf(10);
  const line = data.subarray(0, end < 0 ? data.length : end).toString('utf8');
  const oid = line.slice('object '.length).trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

// ---------------------------------------------------------------- zlib at an offset

/**
 * Inflate one zlib stream starting at `offset`, reporting where it ended. Pack entries are laid out
 * back to back, so the caller needs the exact byte count of the compressed stream, not just its bytes.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const slice = buf.subarray(offset);
  const result = zlib.inflateSync(slice, {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
    info: true,
  } as zlib.ZlibOptions) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const consumed = result.engine.bytesWritten;
  if (!Number.isFinite(consumed) || consumed <= 0) throw new Error('zlib reported no bytes consumed');
  return { data: result.buffer, next: offset + consumed };
}

// ---------------------------------------------------------------- packfiles

function readVarintSize(buf: Buffer, start: number, wholeByte: boolean): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = buf[offset];
    if (byte === undefined) throw new Error('pack varint ran past the buffer');
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 56) throw new Error('pack varint is too long');
  }
  if (wholeByte && value < 0) throw new Error('negative pack size');
  return { value, next: offset };
}

function readOfsDeltaBase(buf: Buffer, start: number): { distance: number; next: number } {
  let byte = buf[start];
  if (byte === undefined) throw new Error('ofs-delta ran past the buffer');
  let offset = start + 1;
  let distance = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buf[offset];
    if (byte === undefined) throw new Error('ofs-delta ran past the buffer');
    offset += 1;
    distance = (distance + 1) * 128 + (byte & 0x7f);
  }
  return { distance, next: offset };
}

/** Apply a git delta (base size, result size, then copy/insert ops) to its base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      if (byte === undefined) throw new Error('delta size ran past the buffer');
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return value;
  };
  const baseSize = readSize();
  if (baseSize !== base.length) throw new Error(`delta expects a ${baseSize}-byte base, got ${base.length}`);
  const resultSize = readSize();
  const out = Buffer.allocUnsafe(resultSize);
  let wrote = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op === 0) throw new Error('delta has a reserved opcode 0');
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset += (delta[offset++] as number);
      if (op & 0x02) copyOffset += (delta[offset++] as number) * 0x100;
      if (op & 0x04) copyOffset += (delta[offset++] as number) * 0x10000;
      if (op & 0x08) copyOffset += (delta[offset++] as number) * 0x1000000;
      if (op & 0x10) copySize += (delta[offset++] as number);
      if (op & 0x20) copySize += (delta[offset++] as number) * 0x100;
      if (op & 0x40) copySize += (delta[offset++] as number) * 0x10000;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      base.copy(out, wrote, copyOffset, copyOffset + copySize);
      wrote += copySize;
    } else {
      const size = op;
      if (offset + size > delta.length) throw new Error('delta insert runs past its bytes');
      delta.copy(out, wrote, offset, offset + size);
      wrote += size;
      offset += size;
    }
  }
  if (wrote !== resultSize) throw new Error(`delta produced ${wrote} bytes, declared ${resultSize}`);
  return out;
}

export interface PackRead {
  readonly objects: Map<string, GitObject>;
  readonly version: number;
  readonly declaredCount: number;
  readonly deltaCount: number;
}

/**
 * Read a whole packfile: header, entries (plain and delta), trailer. Every object's SHA-1 is
 * recomputed and used as its key; a mismatch is an error, never a silent alias.
 */
export function readPack(buf: Buffer): PackRead {
  if (buf.length < 32) throw new Error('pack is shorter than its header and trailer');
  if (buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const body = buf.subarray(0, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(body).digest('hex');
  if (trailer !== actual) throw new Error(`pack trailer ${trailer} does not match its bytes ${actual}`);

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  const pending: Array<{ offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }> = [];
  let offset = 12;
  let deltaCount = 0;
  const types: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    let byte = buf[offset];
    if (byte === undefined) throw new Error('pack ended before its declared object count');
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset];
      if (byte === undefined) throw new Error('pack object header ran past the buffer');
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      const read = readOfsDeltaBase(buf, offset);
      offset = read.next;
      baseOffset = entryOffset - read.distance;
      deltaCount += 1;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      deltaCount += 1;
    } else if (types[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error(`pack entry inflated to ${inflated.data.length} bytes, declared ${size}`);
    const type = types[typeCode];
    if (type === undefined) {
      pending.push({ offset: entryOffset, type: typeCode, data: inflated.data, baseOffset, baseOid });
    } else {
      const oid = oidOf(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      byOffset.set(entryOffset, oid);
    }
  }

  // Resolve deltas in place; a base may itself be a delta, so loop until the set stops shrinking.
  let remaining = pending;
  while (remaining.length > 0) {
    const still: typeof remaining = [];
    for (const entry of remaining) {
      const base =
        entry.baseOffset !== undefined
          ? (() => {
              const oid = byOffset.get(entry.baseOffset as number);
              return oid === undefined ? undefined : objects.get(oid);
            })()
          : entry.baseOid !== undefined
            ? objects.get(entry.baseOid)
            : undefined;
      if (base === undefined) {
        still.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      const oid = oidOf(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entry.offset, oid);
    }
    if (still.length === remaining.length) throw new Error('pack has a delta whose base is missing');
    remaining = still;
  }

  return { objects, version, declaredCount, deltaCount };
}

function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (type << 4) | (remaining % 16);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining % 128;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

const PACK_TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Build a packfile from whole objects, no deltas. Content-addressed by the caller: the same object
 * list always yields the same bytes, so a caller can cache the result.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(PACK_TYPE_CODE[object.type], object.data.length));
    parts.push(zlib.deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Split a pack into sideband payloads: band byte 1 (pack data) followed by a slice. These are raw
 * pkt-line payloads, not frames — the caller's `pktLines` adds the length prefix, so nothing is
 * framed twice.
 */
export function sidebandChunks(pack: Buffer, chunkSize = 60000): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    out.push(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + chunkSize)]));
  }
  return out;
}
