import {
  MOVE_TABLE_SPECS,
  PRUNING_TABLE_SPECS,
  TABLE_ARTIFACT_BYTE_ORDER,
  TABLE_ARTIFACT_FORMAT_VERSION,
  TABLE_ARTIFACT_MAGIC,
  TABLE_FINGERPRINT,
} from './constants.js';
import {
  generateSolverTables,
  type SolverTables,
  type TableGenerationOptions,
} from './tables.js';
import type { TableArtifact, TableStore } from './types.js';

/** Generation callbacks accepted when a cache miss has to rebuild the tables. */
export type LoadTablesOptions = TableGenerationOptions;

type SectionValues = Uint16Array | Uint8Array;

interface SectionDefinition {
  readonly name: string;
  readonly bits: 4 | 16;
  readonly count: number;
  readonly byteLength: number;
  /** Exclusive for move coordinates, inclusive for pruning distances. */
  readonly valueLimit: number;
  readonly values: (tables: SolverTables) => SectionValues;
}

interface DecodedSection {
  readonly definition: SectionDefinition;
  readonly values: SectionValues;
}

const HEADER_BYTE_LENGTH = 28;
const DESCRIPTOR_FIXED_BYTE_LENGTH = 16;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;

const HEADER_FORMAT_VERSION_OFFSET = 4;
const HEADER_BYTE_ORDER_OFFSET = 8;
const HEADER_SECTION_COUNT_OFFSET = 10;
const HEADER_FINGERPRINT_LENGTH_OFFSET = 12;
const HEADER_RESERVED_OFFSET = 14;
const HEADER_DESCRIPTOR_OFFSET_OFFSET = 16;
const HEADER_PAYLOAD_OFFSET_OFFSET = 20;
const HEADER_TOTAL_LENGTH_OFFSET = 24;

const DESCRIPTOR_NAME_LENGTH_OFFSET = 0;
const DESCRIPTOR_BITS_OFFSET = 1;
const DESCRIPTOR_RESERVED_OFFSET = 2;
const DESCRIPTOR_COUNT_OFFSET = 4;
const DESCRIPTOR_DATA_OFFSET_OFFSET = 8;
const DESCRIPTOR_DATA_LENGTH_OFFSET = 12;

function requireMoveSpec(name: string) {
  const spec = MOVE_TABLE_SPECS.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`Missing move-table specification ${name}`);
  }
  return spec;
}

function requirePruningSpec(name: string) {
  const spec = PRUNING_TABLE_SPECS.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`Missing pruning-table specification ${name}`);
  }
  return spec;
}

function moveSection(
  name: string,
  values: (tables: SolverTables) => Uint16Array,
): SectionDefinition {
  const spec = requireMoveSpec(name);
  return Object.freeze({
    name,
    bits: 16,
    count: spec.entryCount,
    byteLength: spec.byteLength,
    valueLimit: spec.coordinateCount,
    values,
  });
}

function pruningSection(
  name: string,
  values: (tables: SolverTables) => Uint8Array,
): SectionDefinition {
  const spec = requirePruningSpec(name);
  return Object.freeze({
    name,
    bits: 4,
    count: spec.entryCount,
    byteLength: spec.byteLength,
    valueLimit: spec.maximumDepth,
    values,
  });
}

/**
 * Descriptor order is part of artifact format v1. Descriptors carry names as
 * well, so a decoder rejects a reordered or substituted section rather than
 * silently wiring the right bytes to the wrong coordinate.
 */
const SECTION_DEFINITIONS: readonly SectionDefinition[] = Object.freeze([
  moveSection('co', (tables) => tables.moveTables.co),
  moveSection('eo', (tables) => tables.moveTables.eo),
  moveSection('ud-slice', (tables) => tables.moveTables.udSlice),
  moveSection('cp', (tables) => tables.moveTables.cp),
  moveSection('ud-edge-perm', (tables) => tables.moveTables.udEdgePerm),
  moveSection('slice-perm', (tables) => tables.moveTables.slicePerm),
  pruningSection('co-ud-slice', (tables) => tables.pruningTables.coUDSlice),
  pruningSection('eo-ud-slice', (tables) => tables.pruningTables.eoUDSlice),
  pruningSection('cp-slice-perm', (tables) => tables.pruningTables.cpSlicePerm),
  pruningSection(
    'ud-edge-perm-slice-perm',
    (tables) => tables.pruningTables.udEdgePermSlicePerm,
  ),
]);

function asciiBytes(value: string, label: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      throw new Error(`${label} must contain ASCII characters only`);
    }
    bytes[index] = code;
  }
  return bytes;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    const code = bytes[offset + index]!;
    if (code > 0x7f) throw new Error('Artifact metadata is not valid ASCII');
    value += String.fromCharCode(code);
  }
  return value;
}

function checkedUint16(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT16_MAX) {
    throw new RangeError(`${label} does not fit in an unsigned 16-bit integer`);
  }
  return value;
}

function checkedUint32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} does not fit in an unsigned 32-bit integer`);
  }
  return value;
}

function expectedDescriptorByteLength(): number {
  return SECTION_DEFINITIONS.reduce(
    (total, definition) =>
      total +
      DESCRIPTOR_FIXED_BYTE_LENGTH +
      asciiBytes(definition.name, 'Section name').length,
    0,
  );
}

function expectedPayloadByteLength(): number {
  return SECTION_DEFINITIONS.reduce(
    (total, definition) => total + definition.byteLength,
    0,
  );
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder =
        (remainder & 1) === 0
          ? remainder >>> 1
          : 0xedb8_8320 ^ (remainder >>> 1);
    }
    table[value] = remainder >>> 0;
  }
  return table;
})();

function checksumBytes(bytes: Uint8Array): string {
  let checksum = UINT32_MAX;
  for (const byte of bytes) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  }
  const hexadecimal = ((checksum ^ UINT32_MAX) >>> 0)
    .toString(16)
    .padStart(8, '0');
  return `crc32:${hexadecimal}`;
}

function assertTables(tables: SolverTables): void {
  if (typeof tables !== 'object' || tables === null) {
    throw new TypeError('Solver tables must be an object');
  }
  if (
    typeof tables.moveTables !== 'object' ||
    tables.moveTables === null ||
    typeof tables.pruningTables !== 'object' ||
    tables.pruningTables === null
  ) {
    throw new TypeError('Solver tables must contain moveTables and pruningTables');
  }

  for (const definition of SECTION_DEFINITIONS) {
    const values = definition.values(tables);
    if (definition.bits === 16) {
      if (!(values instanceof Uint16Array)) {
        throw new TypeError(`Table section ${definition.name} must be a Uint16Array`);
      }
      if (values.length !== definition.count) {
        throw new RangeError(
          `Table section ${definition.name} must contain ${definition.count} entries`,
        );
      }
      for (const coordinate of values) {
        if (coordinate >= definition.valueLimit) {
          throw new RangeError(
            `Table section ${definition.name} contains an out-of-range transition`,
          );
        }
      }
    } else {
      if (!(values instanceof Uint8Array) || values instanceof Uint16Array) {
        throw new TypeError(`Table section ${definition.name} must be a Uint8Array`);
      }
      if (values.byteLength !== definition.byteLength) {
        throw new RangeError(
          `Table section ${definition.name} must contain ${definition.byteLength} bytes`,
        );
      }
      const distances = values as Uint8Array;
      for (let index = 0; index < definition.count; index += 1) {
        const packed = distances[index >>> 1]!;
        const distance = (index & 1) === 0 ? packed & 0x0f : packed >>> 4;
        if (distance > definition.valueLimit) {
          throw new RangeError(
            `Table section ${definition.name} contains an invalid pruning distance`,
          );
        }
      }
      if ((distances[0]! & 0x0f) !== 0) {
        throw new RangeError(
          `Table section ${definition.name} must have distance zero at its target`,
        );
      }
      if (
        definition.count % 2 === 1 &&
        distances[distances.length - 1]! >>> 4 !== 0x0f
      ) {
        throw new RangeError(
          `Table section ${definition.name} has a non-empty padding nibble`,
        );
      }
    }
  }
}

function encodeSection(
  target: Uint8Array,
  dataOffset: number,
  definition: SectionDefinition,
  values: SectionValues,
): void {
  if (definition.bits === 4) {
    target.set(values as Uint8Array, dataOffset);
    return;
  }

  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  const entries = values as Uint16Array;
  for (let index = 0; index < entries.length; index += 1) {
    view.setUint16(dataOffset + index * Uint16Array.BYTES_PER_ELEMENT, entries[index]!, true);
  }
}

/** Encode all solver tables into the versioned, platform-neutral binary format. */
export function createTableArtifact(tables: SolverTables): TableArtifact {
  assertTables(tables);

  const magic = asciiBytes(TABLE_ARTIFACT_MAGIC, 'Artifact magic');
  if (magic.length !== HEADER_FORMAT_VERSION_OFFSET) {
    throw new Error('Artifact magic must occupy exactly four bytes');
  }
  const byteOrder = asciiBytes(TABLE_ARTIFACT_BYTE_ORDER, 'Artifact byte order');
  if (byteOrder.length !== 2) {
    throw new Error('Artifact byte order marker must occupy exactly two bytes');
  }
  const fingerprint = asciiBytes(TABLE_FINGERPRINT, 'Table fingerprint');
  checkedUint16(fingerprint.length, 'Fingerprint length');
  checkedUint16(SECTION_DEFINITIONS.length, 'Section count');

  const descriptorOffset = HEADER_BYTE_LENGTH + fingerprint.length;
  const payloadOffset = descriptorOffset + expectedDescriptorByteLength();
  const totalLength = payloadOffset + expectedPayloadByteLength();
  checkedUint32(descriptorOffset, 'Descriptor offset');
  checkedUint32(payloadOffset, 'Payload offset');
  checkedUint32(totalLength, 'Artifact length');

  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(magic, 0);
  view.setUint32(
    HEADER_FORMAT_VERSION_OFFSET,
    checkedUint32(TABLE_ARTIFACT_FORMAT_VERSION, 'Artifact format version'),
    true,
  );
  bytes.set(byteOrder, HEADER_BYTE_ORDER_OFFSET);
  view.setUint16(HEADER_SECTION_COUNT_OFFSET, SECTION_DEFINITIONS.length, true);
  view.setUint16(HEADER_FINGERPRINT_LENGTH_OFFSET, fingerprint.length, true);
  view.setUint16(HEADER_RESERVED_OFFSET, 0, true);
  view.setUint32(HEADER_DESCRIPTOR_OFFSET_OFFSET, descriptorOffset, true);
  view.setUint32(HEADER_PAYLOAD_OFFSET_OFFSET, payloadOffset, true);
  view.setUint32(HEADER_TOTAL_LENGTH_OFFSET, totalLength, true);
  bytes.set(fingerprint, HEADER_BYTE_LENGTH);

  let descriptorCursor = descriptorOffset;
  let dataCursor = payloadOffset;
  for (const definition of SECTION_DEFINITIONS) {
    const name = asciiBytes(definition.name, 'Section name');
    if (name.length > 0xff) {
      throw new RangeError(`Section name ${definition.name} is too long`);
    }
    checkedUint32(definition.count, `${definition.name} entry count`);
    checkedUint32(dataCursor, `${definition.name} offset`);
    checkedUint32(definition.byteLength, `${definition.name} byte length`);

    view.setUint8(
      descriptorCursor + DESCRIPTOR_NAME_LENGTH_OFFSET,
      name.length,
    );
    view.setUint8(descriptorCursor + DESCRIPTOR_BITS_OFFSET, definition.bits);
    view.setUint16(descriptorCursor + DESCRIPTOR_RESERVED_OFFSET, 0, true);
    view.setUint32(
      descriptorCursor + DESCRIPTOR_COUNT_OFFSET,
      definition.count,
      true,
    );
    view.setUint32(
      descriptorCursor + DESCRIPTOR_DATA_OFFSET_OFFSET,
      dataCursor,
      true,
    );
    view.setUint32(
      descriptorCursor + DESCRIPTOR_DATA_LENGTH_OFFSET,
      definition.byteLength,
      true,
    );
    bytes.set(name, descriptorCursor + DESCRIPTOR_FIXED_BYTE_LENGTH);

    encodeSection(bytes, dataCursor, definition, definition.values(tables));
    descriptorCursor += DESCRIPTOR_FIXED_BYTE_LENGTH + name.length;
    dataCursor += definition.byteLength;
  }

  return {
    formatVersion: TABLE_ARTIFACT_FORMAT_VERSION,
    solverFingerprint: TABLE_FINGERPRINT,
    byteOrder: TABLE_ARTIFACT_BYTE_ORDER,
    byteLength: bytes.byteLength,
    checksum: checksumBytes(bytes),
    bytes,
  };
}

function assertArtifactEnvelope(artifact: TableArtifact): Uint8Array {
  if (typeof artifact !== 'object' || artifact === null) {
    throw new TypeError('Table artifact must be an object');
  }
  if (artifact.formatVersion !== TABLE_ARTIFACT_FORMAT_VERSION) {
    throw new Error('Table artifact has an unsupported format version');
  }
  if (artifact.solverFingerprint !== TABLE_FINGERPRINT) {
    throw new Error('Table artifact fingerprint does not match this table build');
  }
  if (artifact.byteOrder !== TABLE_ARTIFACT_BYTE_ORDER) {
    throw new Error('Table artifact has an unsupported byte order');
  }
  if (!(artifact.bytes instanceof Uint8Array)) {
    throw new TypeError('Table artifact bytes must be a Uint8Array');
  }
  if (
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 0 ||
    artifact.byteLength !== artifact.bytes.byteLength
  ) {
    throw new Error('Table artifact byteLength does not match its bytes');
  }
  const expectedByteLength =
    HEADER_BYTE_LENGTH +
    asciiBytes(TABLE_FINGERPRINT, 'Table fingerprint').length +
    expectedDescriptorByteLength() +
    expectedPayloadByteLength();
  if (artifact.byteLength !== expectedByteLength) {
    throw new Error('Table artifact byteLength is not valid for this table build');
  }
  if (
    typeof artifact.checksum !== 'string' ||
    !/^crc32:[0-9a-f]{8}$/u.test(artifact.checksum)
  ) {
    throw new Error('Table artifact checksum must use crc32:xxxxxxxx format');
  }

  // Copy before hashing or parsing so a caller cannot mutate the artifact's
  // backing buffer between validation and construction of the returned tables.
  const bytes = Uint8Array.from(artifact.bytes);
  if (checksumBytes(bytes) !== artifact.checksum) {
    throw new Error('Table artifact checksum mismatch');
  }
  return bytes;
}

function validateHeader(bytes: Uint8Array): {
  readonly descriptorOffset: number;
  readonly payloadOffset: number;
} {
  if (bytes.byteLength < HEADER_BYTE_LENGTH) {
    throw new Error('Table artifact is truncated before its header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (asciiAt(bytes, 0, HEADER_FORMAT_VERSION_OFFSET) !== TABLE_ARTIFACT_MAGIC) {
    throw new Error('Table artifact magic is invalid');
  }
  if (
    view.getUint32(HEADER_FORMAT_VERSION_OFFSET, true) !==
    TABLE_ARTIFACT_FORMAT_VERSION
  ) {
    throw new Error('Encoded table artifact version is invalid');
  }
  if (asciiAt(bytes, HEADER_BYTE_ORDER_OFFSET, 2) !== TABLE_ARTIFACT_BYTE_ORDER) {
    throw new Error('Encoded table artifact byte order is invalid');
  }
  if (view.getUint16(HEADER_SECTION_COUNT_OFFSET, true) !== SECTION_DEFINITIONS.length) {
    throw new Error('Encoded table artifact section count is invalid');
  }
  if (view.getUint16(HEADER_RESERVED_OFFSET, true) !== 0) {
    throw new Error('Encoded table artifact header has non-zero reserved bits');
  }

  const fingerprint = asciiBytes(TABLE_FINGERPRINT, 'Table fingerprint');
  const fingerprintLength = view.getUint16(
    HEADER_FINGERPRINT_LENGTH_OFFSET,
    true,
  );
  if (fingerprintLength !== fingerprint.length) {
    throw new Error('Encoded table artifact fingerprint length is invalid');
  }
  const descriptorOffset = view.getUint32(
    HEADER_DESCRIPTOR_OFFSET_OFFSET,
    true,
  );
  const expectedDescriptorOffset = HEADER_BYTE_LENGTH + fingerprintLength;
  if (descriptorOffset !== expectedDescriptorOffset) {
    throw new Error('Encoded table artifact descriptor offset is invalid');
  }
  if (descriptorOffset > bytes.byteLength) {
    throw new Error('Encoded table artifact fingerprint exceeds its bounds');
  }
  if (asciiAt(bytes, HEADER_BYTE_LENGTH, fingerprintLength) !== TABLE_FINGERPRINT) {
    throw new Error('Encoded table artifact fingerprint is invalid');
  }

  const payloadOffset = view.getUint32(HEADER_PAYLOAD_OFFSET_OFFSET, true);
  const expectedPayloadOffset = descriptorOffset + expectedDescriptorByteLength();
  if (payloadOffset !== expectedPayloadOffset || payloadOffset > bytes.byteLength) {
    throw new Error('Encoded table artifact payload offset is invalid');
  }
  const expectedTotalLength = payloadOffset + expectedPayloadByteLength();
  if (
    view.getUint32(HEADER_TOTAL_LENGTH_OFFSET, true) !== expectedTotalLength ||
    bytes.byteLength !== expectedTotalLength
  ) {
    throw new Error('Encoded table artifact total length is invalid');
  }
  return { descriptorOffset, payloadOffset };
}

function validateDescriptors(
  bytes: Uint8Array,
  descriptorOffset: number,
  payloadOffset: number,
): readonly { readonly definition: SectionDefinition; readonly offset: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections: Array<{
    readonly definition: SectionDefinition;
    readonly offset: number;
  }> = [];
  let descriptorCursor = descriptorOffset;
  let dataCursor = payloadOffset;

  for (const definition of SECTION_DEFINITIONS) {
    if (descriptorCursor + DESCRIPTOR_FIXED_BYTE_LENGTH > payloadOffset) {
      throw new Error(`Descriptor for ${definition.name} exceeds descriptor bounds`);
    }
    const expectedName = asciiBytes(definition.name, 'Section name');
    const nameLength = view.getUint8(
      descriptorCursor + DESCRIPTOR_NAME_LENGTH_OFFSET,
    );
    if (
      nameLength !== expectedName.length ||
      descriptorCursor + DESCRIPTOR_FIXED_BYTE_LENGTH + nameLength > payloadOffset
    ) {
      throw new Error(`Descriptor name length for ${definition.name} is invalid`);
    }
    const name = asciiAt(
      bytes,
      descriptorCursor + DESCRIPTOR_FIXED_BYTE_LENGTH,
      nameLength,
    );
    if (name !== definition.name) {
      throw new Error(`Expected table section ${definition.name}, received ${name}`);
    }
    if (view.getUint8(descriptorCursor + DESCRIPTOR_BITS_OFFSET) !== definition.bits) {
      throw new Error(`Table section ${definition.name} has an invalid element width`);
    }
    if (view.getUint16(descriptorCursor + DESCRIPTOR_RESERVED_OFFSET, true) !== 0) {
      throw new Error(`Table section ${definition.name} has non-zero reserved bits`);
    }
    if (
      view.getUint32(descriptorCursor + DESCRIPTOR_COUNT_OFFSET, true) !==
      definition.count
    ) {
      throw new Error(`Table section ${definition.name} has an invalid entry count`);
    }
    const offset = view.getUint32(
      descriptorCursor + DESCRIPTOR_DATA_OFFSET_OFFSET,
      true,
    );
    const length = view.getUint32(
      descriptorCursor + DESCRIPTOR_DATA_LENGTH_OFFSET,
      true,
    );
    if (offset !== dataCursor || length !== definition.byteLength) {
      throw new Error(`Table section ${definition.name} has invalid data bounds`);
    }
    if (offset + length > bytes.byteLength) {
      throw new Error(`Table section ${definition.name} exceeds artifact bounds`);
    }

    sections.push({ definition, offset });
    descriptorCursor += DESCRIPTOR_FIXED_BYTE_LENGTH + nameLength;
    dataCursor += length;
  }

  if (descriptorCursor !== payloadOffset || dataCursor !== bytes.byteLength) {
    throw new Error('Table artifact sections do not exactly cover their regions');
  }
  return sections;
}

function decodeSection(
  bytes: Uint8Array,
  definition: SectionDefinition,
  offset: number,
): DecodedSection {
  if (definition.bits === 4) {
    return {
      definition,
      values: bytes.slice(offset, offset + definition.byteLength),
    };
  }

  const values = new Uint16Array(definition.count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = view.getUint16(
      offset + index * Uint16Array.BYTES_PER_ELEMENT,
      true,
    );
  }
  return { definition, values };
}

function requireDecoded<T extends SectionValues>(
  sections: readonly DecodedSection[],
  name: string,
  constructor: Uint8ArrayConstructor | Uint16ArrayConstructor,
): T {
  const section = sections.find((candidate) => candidate.definition.name === name);
  if (section === undefined || !(section.values instanceof constructor)) {
    throw new Error(`Decoded artifact is missing table section ${name}`);
  }
  return section.values as T;
}

/** Validate and decode an artifact without retaining any caller-owned buffer. */
export function decodeTableArtifact(artifact: TableArtifact): SolverTables {
  const bytes = assertArtifactEnvelope(artifact);
  const { descriptorOffset, payloadOffset } = validateHeader(bytes);
  const descriptors = validateDescriptors(bytes, descriptorOffset, payloadOffset);
  const sections = descriptors.map(({ definition, offset }) =>
    decodeSection(bytes, definition, offset),
  );

  const tables = Object.freeze({
    moveTables: Object.freeze({
      co: requireDecoded<Uint16Array>(sections, 'co', Uint16Array),
      eo: requireDecoded<Uint16Array>(sections, 'eo', Uint16Array),
      udSlice: requireDecoded<Uint16Array>(sections, 'ud-slice', Uint16Array),
      cp: requireDecoded<Uint16Array>(sections, 'cp', Uint16Array),
      udEdgePerm: requireDecoded<Uint16Array>(
        sections,
        'ud-edge-perm',
        Uint16Array,
      ),
      slicePerm: requireDecoded<Uint16Array>(sections, 'slice-perm', Uint16Array),
    }),
    pruningTables: Object.freeze({
      coUDSlice: requireDecoded<Uint8Array>(sections, 'co-ud-slice', Uint8Array),
      eoUDSlice: requireDecoded<Uint8Array>(sections, 'eo-ud-slice', Uint8Array),
      cpSlicePerm: requireDecoded<Uint8Array>(
        sections,
        'cp-slice-perm',
        Uint8Array,
      ),
      udEdgePermSlicePerm: requireDecoded<Uint8Array>(
        sections,
        'ud-edge-perm-slice-perm',
        Uint8Array,
      ),
    }),
  });
  assertTables(tables);
  return tables;
}

function assertStore(store: TableStore | undefined): void {
  if (store === undefined) return;
  if (
    typeof store !== 'object' ||
    store === null ||
    typeof store.load !== 'function' ||
    typeof store.save !== 'function'
  ) {
    throw new TypeError('Table store must provide load and save methods');
  }
}

async function loadOrGenerate(
  store: TableStore | undefined,
  options: LoadTablesOptions | undefined,
): Promise<SolverTables> {
  if (store !== undefined) {
    try {
      const cached = await store.load(TABLE_FINGERPRINT);
      if (cached !== null) return decodeTableArtifact(cached);
    } catch {
      // A cache is an optimization. Read, transport, or validation failures all
      // fall back to the deterministic generator rather than failing ready().
    }
  }

  const tables = generateSolverTables(options);
  if (store !== undefined) {
    try {
      await store.save(TABLE_FINGERPRINT, createTableArtifact(tables));
    } catch {
      // The generated tables are already usable; persistence only affects the
      // next cold start and must not make this one fail.
    }
  }
  return tables;
}

const TABLE_LOADS = new Map<string, Promise<SolverTables>>();

/**
 * Load, validate, or generate the process-wide table set for this fingerprint.
 * The microtask boundary installs the shared Promise before cache I/O or the
 * synchronous generator can re-enter this function. The first caller owns the
 * store and progress options for the lifetime of a successful module instance.
 * Returned typed arrays are shared solver-owned lookup storage and must not be
 * mutated by consumers.
 */
export function loadTables(
  store?: TableStore,
  options?: LoadTablesOptions,
): Promise<SolverTables> {
  assertStore(store);
  const existing = TABLE_LOADS.get(TABLE_FINGERPRINT);
  if (existing !== undefined) return existing;

  let shared!: Promise<SolverTables>;
  shared = Promise.resolve()
    .then(() => loadOrGenerate(store, options))
    .catch((error: unknown) => {
      if (TABLE_LOADS.get(TABLE_FINGERPRINT) === shared) {
        TABLE_LOADS.delete(TABLE_FINGERPRINT);
      }
      throw error;
    });
  TABLE_LOADS.set(TABLE_FINGERPRINT, shared);
  return shared;
}
