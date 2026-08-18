import {
  assertValidState,
  cloneState,
  CORNER_COUNT,
  EDGE_COUNT,
  type CubeState,
} from './state.js';

export const FACES = Object.freeze(['U', 'D', 'L', 'R', 'F', 'B'] as const);

export type Face = (typeof FACES)[number];
export type TurnCount = 1 | 2 | 3;

export interface Move {
  readonly face: Face;
  /** Number of clockwise quarter turns; 3 is conventionally serialized as `'`. */
  readonly turns: TurnCount;
}

export type FaceAxis = 'UD' | 'LR' | 'FB';

const FACE_SET: ReadonlySet<string> = new Set(FACES);
const FACE_AXES: Readonly<Record<Face, FaceAxis>> = {
  U: 'UD',
  D: 'UD',
  L: 'LR',
  R: 'LR',
  F: 'FB',
  B: 'FB',
};

const OPPOSITE_FACES: Readonly<Record<Face, Face>> = {
  U: 'D',
  D: 'U',
  L: 'R',
  R: 'L',
  F: 'B',
  B: 'F',
};

interface CubieTransform {
  readonly cp: readonly number[];
  readonly co: readonly number[];
  readonly ep: readonly number[];
  readonly eo: readonly number[];
}

/**
 * Clockwise quarter-turn transforms in the Kociemba cubie ordering.
 *
 * Corners: URF UFL ULB UBR DFR DLF DBL DRB
 * Edges:   UR UF UL UB DR DF DL DB FR FL BL BR
 *
 * Each permutation maps destination position to its previous source position.
 */
const QUARTER_TURNS: Readonly<Record<Face, CubieTransform>> = {
  U: {
    cp: [3, 0, 1, 2, 4, 5, 6, 7],
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  D: {
    cp: [0, 1, 2, 3, 5, 6, 7, 4],
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [0, 1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  L: {
    cp: [0, 2, 6, 3, 4, 1, 5, 7],
    co: [0, 1, 2, 0, 0, 2, 1, 0],
    ep: [0, 1, 10, 3, 4, 5, 9, 7, 8, 2, 6, 11],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  R: {
    cp: [4, 1, 2, 0, 7, 5, 6, 3],
    co: [2, 0, 0, 1, 1, 0, 0, 2],
    ep: [8, 1, 2, 3, 11, 5, 6, 7, 4, 9, 10, 0],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  F: {
    cp: [1, 5, 2, 3, 0, 4, 6, 7],
    co: [1, 2, 0, 0, 2, 1, 0, 0],
    ep: [0, 9, 2, 3, 4, 8, 6, 7, 1, 5, 10, 11],
    eo: [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0],
  },
  B: {
    cp: [0, 1, 3, 7, 4, 5, 2, 6],
    co: [0, 0, 1, 2, 0, 0, 2, 1],
    ep: [0, 1, 2, 11, 4, 5, 6, 10, 8, 9, 3, 7],
    eo: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1],
  },
};

export class MoveParseError extends Error {
  readonly token: string;
  readonly tokenIndex: number;

  constructor(token: string, tokenIndex: number) {
    super(`Invalid HTM move at token ${tokenIndex}: ${JSON.stringify(token)}`);
    this.name = 'MoveParseError';
    this.token = token;
    this.tokenIndex = tokenIndex;
  }
}

export const ALL_HTM_MOVES: readonly Move[] = Object.freeze(
  FACES.flatMap(
    (face): Move[] => [
      Object.freeze({ face, turns: 1 }),
      Object.freeze({ face, turns: 3 }),
      Object.freeze({ face, turns: 2 }),
    ],
  ),
);

export function isFace(value: unknown): value is Face {
  return typeof value === 'string' && FACE_SET.has(value);
}

export function isMove(value: unknown): value is Move {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Move>;
  return (
    isFace(candidate.face) &&
    (candidate.turns === 1 || candidate.turns === 2 || candidate.turns === 3)
  );
}

export function assertMove(value: unknown): asserts value is Move {
  if (!isMove(value)) {
    throw new TypeError('Move must have a face in U/D/L/R/F/B and turns of 1, 2, or 3');
  }
}

export function faceAxis(face: Face): FaceAxis {
  return FACE_AXES[face];
}

export function oppositeFace(face: Face): Face {
  return OPPOSITE_FACES[face];
}

export function parseMove(token: string, tokenIndex = 0): Move {
  const match = /^([UDLRFB])([2']?)$/.exec(token);
  if (match === null) throw new MoveParseError(token, tokenIndex);

  const face = match[1] as Face;
  const suffix = match[2];
  return {
    face,
    turns: suffix === '2' ? 2 : suffix === "'" ? 3 : 1,
  };
}

export function parseMoves(sequence: string): Move[] {
  if (typeof sequence !== 'string') {
    throw new TypeError('Move sequence must be a string');
  }

  const trimmed = sequence.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/u).map((token, index) => parseMove(token, index));
}

export function serializeMove(move: Move): string {
  assertMove(move);
  const suffix = move.turns === 2 ? '2' : move.turns === 3 ? "'" : '';
  return `${move.face}${suffix}`;
}

export function serializeMoves(moves: readonly Move[]): string {
  return moves.map(serializeMove).join(' ');
}

export function invertMove(move: Move): Move {
  assertMove(move);
  return {
    face: move.face,
    turns: move.turns === 1 ? 3 : move.turns === 3 ? 1 : 2,
  };
}

export function invertMoves(moves: readonly Move[]): Move[] {
  return [...moves].reverse().map(invertMove);
}

/**
 * One whole move as a single destination-indexed table, in exactly the form
 * {@link QUARTER_TURNS} uses: position `p` receives the cubie sitting at
 * `cp[p]` before the move, and `co[p]` is the orientation delta it picks up.
 */
interface CompiledTransform {
  readonly cp: Uint8Array;
  readonly co: Uint8Array;
  readonly ep: Uint8Array;
  readonly eo: Uint8Array;
}

/** The table for applying `first` and then `second` in one pass. */
function composeTransforms(
  first: CompiledTransform,
  second: CompiledTransform,
): CompiledTransform {
  const cp = new Uint8Array(CORNER_COUNT);
  const co = new Uint8Array(CORNER_COUNT);
  const ep = new Uint8Array(EDGE_COUNT);
  const eo = new Uint8Array(EDGE_COUNT);

  for (let position = 0; position < CORNER_COUNT; position += 1) {
    const via = second.cp[position]!;
    cp[position] = first.cp[via]!;
    co[position] = (first.co[via]! + second.co[position]!) % 3;
  }

  for (let position = 0; position < EDGE_COUNT; position += 1) {
    const via = second.ep[position]!;
    ep[position] = first.ep[via]!;
    eo[position] = (first.eo[via]! + second.eo[position]!) % 2;
  }

  return { cp, co, ep, eo };
}

function compileMoveTable(face: Face): Readonly<Record<TurnCount, CompiledTransform>> {
  const source = QUARTER_TURNS[face];
  const quarter: CompiledTransform = {
    cp: Uint8Array.from(source.cp),
    co: Uint8Array.from(source.co),
    ep: Uint8Array.from(source.ep),
    eo: Uint8Array.from(source.eo),
  };
  const half = composeTransforms(quarter, quarter);
  return Object.freeze({ 1: quarter, 2: half, 3: composeTransforms(half, quarter) });
}

/**
 * All 18 HTM moves precomposed at load. A half turn or a counter-clockwise turn
 * then costs one pass instead of repeating the quarter turn two or three times.
 */
const MOVE_TRANSFORMS: Readonly<
  Record<Face, Readonly<Record<TurnCount, CompiledTransform>>>
> = Object.freeze({
  U: compileMoveTable('U'),
  D: compileMoveTable('D'),
  L: compileMoveTable('L'),
  R: compileMoveTable('R'),
  F: compileMoveTable('F'),
  B: compileMoveTable('B'),
});

/**
 * Write `source` transformed by `transform` into `target`.
 *
 * `target` must not alias `source`: every destination is read from the source's
 * pre-move value, and keeping the two apart is what removes the temporary copy
 * an in-place permutation would otherwise need.
 */
function applyTransform(
  target: CubeState,
  source: CubeState,
  transform: CompiledTransform,
): void {
  for (let position = 0; position < CORNER_COUNT; position += 1) {
    const from = transform.cp[position]!;
    target.cp[position] = source.cp[from]!;
    target.co[position] = (source.co[from]! + transform.co[position]!) % 3;
  }

  for (let position = 0; position < EDGE_COUNT; position += 1) {
    const from = transform.ep[position]!;
    target.ep[position] = source.ep[from]!;
    target.eo[position] = (source.eo[from]! + transform.eo[position]!) % 2;
  }
}

/** Zeroed buffers shaped like a state. Only ever handed to `applyTransform`. */
function allocateState(): CubeState {
  return {
    cp: new Uint8Array(CORNER_COUNT),
    co: new Uint8Array(CORNER_COUNT),
    ep: new Uint8Array(EDGE_COUNT),
    eo: new Uint8Array(EDGE_COUNT),
  };
}

function copyStateInto(target: CubeState, source: CubeState): void {
  target.cp.set(source.cp);
  target.co.set(source.co);
  target.ep.set(source.ep);
  target.eo.set(source.eo);
}

function transformFor(move: Move): CompiledTransform {
  return MOVE_TRANSFORMS[move.face][move.turns];
}

/** Apply a move to a clone, leaving the input state untouched. */
export function applyMove(state: CubeState, move: Move): CubeState {
  assertValidState(state);
  assertMove(move);
  const result = allocateState();
  applyTransform(result, state, transformFor(move));
  return result;
}

/** Apply a sequence to a clone, leaving the input state untouched. */
export function applyMoves(
  state: CubeState,
  moves: readonly Move[] | string,
): CubeState {
  assertValidState(state);
  const parsed = typeof moves === 'string' ? parseMoves(moves) : moves;
  for (const move of parsed) assertMove(move);
  if (parsed.length === 0) return cloneState(state);

  let current = allocateState();
  applyTransform(current, state, transformFor(parsed[0]!));
  if (parsed.length === 1) return current;

  // Ping-pong between two buffers, so the whole sequence costs two allocations
  // no matter how long it is.
  let spare = allocateState();
  for (let index = 1; index < parsed.length; index += 1) {
    applyTransform(spare, current, transformFor(parsed[index]!));
    const previous = current;
    current = spare;
    spare = previous;
  }
  return current;
}

/** Mutating variant for render loops and search code that own their state. */
export function applyMovesInPlace(
  state: CubeState,
  moves: readonly Move[] | string,
): CubeState {
  assertValidState(state);
  const parsed = typeof moves === 'string' ? parseMoves(moves) : moves;
  for (const move of parsed) assertMove(move);
  if (parsed.length === 0) return state;

  // Ping-pong between the caller's arrays and one scratch state, then copy back
  // only when the result happens to land in the scratch buffer.
  const scratch = allocateState();
  let source: CubeState = state;
  let target: CubeState = scratch;
  for (const move of parsed) {
    applyTransform(target, source, transformFor(move));
    const previous = source;
    source = target;
    target = previous;
  }

  if (source !== state) copyStateInto(state, source);
  return state;
}
