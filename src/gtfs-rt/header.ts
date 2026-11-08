// Minimal protobuf reader for the GTFS-RT FeedMessage envelope. The Worker stores the upstream bytes untouched, so it
// only needs the header timestamp and a framing check: decoding the whole feed (hundreds of entities) would risk the
// 10 ms CPU limit of the Workers free plan in a cold isolate.

export interface FeedHeader {
  /** `gtfs_realtime_version`, e.g. "1.0" or "2.0". */
  version: string;
  /** 0 = FULL_DATASET, 1 = DIFFERENTIAL. */
  incrementality: number;
  /** POSIX seconds at which the upstream produced the feed. */
  timestamp: number;
  /** Number of top-level fields after the header, i.e. feed entities. */
  entities: number;
}

class Reader {
  position = 0;
  readonly bytes: Uint8Array;
  readonly end: number;
  // (No parameter properties: Node runs this file with type stripping only.)
  constructor(bytes: Uint8Array, start = 0) {
    this.bytes = bytes;
    this.end = bytes.length;
    this.position = start;
  }
  get done(): boolean { return this.position >= this.end; }
  varint(): number {
    let value = 0;
    for (let i = 0; i < 10; i++) {
      if (this.position >= this.end) throw new Error('Truncated protobuf varint');
      const byte = this.bytes[this.position++]!;
      value += (byte & 0x7f) * 2 ** (7 * i);
      if (!(byte & 0x80)) {
        if (!Number.isSafeInteger(value)) throw new Error('Protobuf varint exceeds 2^53');
        return value;
      }
    }
    throw new Error('Protobuf varint is too long');
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.advance(8);
    else if (wireType === 5) this.advance(4);
    else if (wireType === 2) this.advance(this.varint());
    else throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }
  advance(length: number): void {
    if (this.position + length > this.end) throw new Error('Protobuf field exceeds the message');
    this.position += length;
  }
}

/**
 * Reads the header and verifies that the whole message is well framed (so a truncated download is rejected), without
 * decoding any entity.
 */
export function readFeedHeader(bytes: Uint8Array): FeedHeader {
  const top = new Reader(bytes);
  let header: Omit<FeedHeader, "entities"> | null = null;
  let entities = 0;
  while (!top.done) {
    const tag = top.varint();
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 1 && wireType === 2) {
      if (header) throw new Error('GTFS-RT feed has two headers');
      const length = top.varint();
      const start = top.position;
      top.advance(length);
      header = parseHeader(new Reader(bytes.subarray(0, start + length), start));
    } else {
      if (field === 2 && wireType === 2) entities++;
      top.skip(wireType);
    }
  }
  if (!header) throw new Error('GTFS-RT feed has no header');
  return { ...header, entities };
}

function parseHeader(reader: Reader): Omit<FeedHeader, 'entities'> {
  let version = '';
  let incrementality = 0;
  let timestamp = 0;
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (field === 1 && wireType === 2) {
      const length = reader.varint();
      const start = reader.position;
      reader.advance(length);
      version = new TextDecoder().decode(reader.bytes.subarray(start, start + length));
    } else if (field === 2 && wireType === 0) incrementality = reader.varint();
    else if (field === 3 && wireType === 0) timestamp = reader.varint();
    else reader.skip(wireType);
  }
  if (!/^\d+\.\d+$/.test(version)) throw new Error('GTFS-RT version missing or invalid');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('GTFS-RT feed timestamp missing or invalid');
  return { version, incrementality, timestamp };
}
