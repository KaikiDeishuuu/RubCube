import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from 'node:zlib';

import {
  TABLE_FINGERPRINT,
  createTableArtifact,
  decodeTableArtifact,
  generateSolverTables,
} from '../dist/solver/index.js';

const maximumCompression = process.argv.includes('--max-compression');
const brotliQuality = maximumCompression ? 11 : 6;

function measure(operation) {
  const started = performance.now();
  const value = operation();
  return { value, elapsedMs: performance.now() - started };
}

function mib(bytes) {
  return bytes / (1024 * 1024);
}

const generated = measure(() => generateSolverTables());
const encoded = measure(() => createTableArtifact(generated.value));
const decoded = measure(() => decodeTableArtifact(encoded.value));
const gzipped = measure(() => gzipSync(encoded.value.bytes, { level: 9 }));
const brotlied = measure(() =>
  brotliCompressSync(encoded.value.bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: brotliQuality,
    },
  }),
);

// Keep the decode result observably live until all timings have completed.
if (decoded.value.moveTables.co.length === 0) {
  throw new Error('Decoded solver tables are unexpectedly empty');
}

const result = {
  schema: 'rubcube-table-benchmark-v1',
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: process.arch,
    logicalCpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
  },
  tableFingerprint: TABLE_FINGERPRINT,
  artifact: {
    byteLength: encoded.value.byteLength,
    mebibytes: Number(mib(encoded.value.byteLength).toFixed(4)),
    checksum: encoded.value.checksum,
    sha256: createHash('sha256').update(encoded.value.bytes).digest('hex'),
  },
  timingsMs: {
    generate: Number(generated.elapsedMs.toFixed(2)),
    encode: Number(encoded.elapsedMs.toFixed(2)),
    decode: Number(decoded.elapsedMs.toFixed(2)),
    gzip9: Number(gzipped.elapsedMs.toFixed(2)),
    [`brotli${brotliQuality}`]: Number(brotlied.elapsedMs.toFixed(2)),
  },
  compressed: {
    gzip9Bytes: gzipped.value.byteLength,
    gzip9Ratio: Number(
      (gzipped.value.byteLength / encoded.value.byteLength).toFixed(4),
    ),
    [`brotli${brotliQuality}Bytes`]: brotlied.value.byteLength,
    [`brotli${brotliQuality}Ratio`]: Number(
      (brotlied.value.byteLength / encoded.value.byteLength).toFixed(4),
    ),
  },
  memory: {
    rssMiB: Number(mib(process.memoryUsage().rss).toFixed(2)),
    heapUsedMiB: Number(mib(process.memoryUsage().heapUsed).toFixed(2)),
    arrayBuffersMiB: Number(mib(process.memoryUsage().arrayBuffers).toFixed(2)),
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
