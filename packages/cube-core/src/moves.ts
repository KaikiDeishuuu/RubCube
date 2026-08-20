import {
  assertValidState,
  CENTER_COUNT,
  cloneState,
  CORNER_COUNT,
  EDGE_COUNT,
  type CubeState,
} from './state.js';

export const FACES = Object.freeze(['U', 'D', 'L', 'R', 'F', 'B'] as const);

/** The three middle layers, each turning with the face it is named after. */
export const SLICES = Object.freeze(['M', 'E', 'S'] as const);

/** Every layer a move can name: the six faces plus the three slices. */
export const LAYERS = Object.freeze([...FACES, ...SLICES] as const);

export type Face = (typeof FACES)[number];
export type Slice = (typeof SLICES)[number];
export type Layer = Face | Slice;
export type TurnCount = 1 | 2 | 3;

export interface Move {
  /** The layer to turn. Slices are legal here; face-only APIs take FaceMove. */
  readonly face: Layer;
  /** Number of clockwise quarter turns; 3 is conventionally serialized as `'`. */
  readonly turns: TurnCount;
}

/**
 * A move restricted to the six outer faces.
 *
 * The solver's coordinates and the WCA scramble grammar are both defined over
 * face turns only, so those surfaces take this rather than {@link Move} and the
 * compiler keeps a slice from reaching them.
 */
export type FaceMove = Move & { readonly face: Face };

export type FaceAxis = 'UD' | 'LR' | 'FB';

const FACE_SET: ReadonlySet<string> = new Set(FACES);
const SLICE_SET: ReadonlySet<string> = new Set(SLICES);
const LAYER_AXES: Readonly<Record<Layer, FaceAxis>> = {
  U: 'UD',
  D: 'UD',
  E: 'UD',
  L: 'LR',
  R: 'LR',
  M: 'LR',
  F: 'FB',
  B: 'FB',
  S: 'FB',
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
  readonly centers: readonly number[];
}

/**
 * Clockwise quarter-turn transforms in the Kociemba cubie ordering.
 *
 * Corners: URF UFL ULB UBR DFR DLF DBL DRB
 * Edges:   UR UF UL UB DR DF DL DB FR FL BL BR
 * Centers: U R F D L B
 *
 * Each permutation maps destination position to its previous source position.
 *
 * Every table here was derived geometrically rather than written by hand: the
 * generator rotates each cubie's position and sticker normals about the layer
 * axis and reads the resulting position and orientation back out. Running it
 * over the six faces reproduces the face tables below byte for byte, which is
 * what licenses the three slice tables it produced alongside them.
 */
const IDENTITY_CORNERS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);
const IDENTITY_CENTERS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5]);

const QUARTER_TURNS: Readonly<Record<Layer, CubieTransform>> = {
  U: {
    cp: [3, 0, 1, 2, 4, 5, 6, 7],
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    centers: IDENTITY_CENTERS,
  },
  D: {
    cp: [0, 1, 2, 3, 5, 6, 7, 4],
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [0, 1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    centers: IDENTITY_CENTERS,
  },
  L: {
    cp: [0, 2, 6, 3, 4, 1, 5, 7],
    co: [0, 1, 2, 0, 0, 2, 1, 0],
    ep: [0, 1, 10, 3, 4, 5, 9, 7, 8, 2, 6, 11],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    centers: IDENTITY_CENTERS,
  },
  R: {
    cp: [4, 1, 2, 0, 7, 5, 6, 3],
    co: [2, 0, 0, 1, 1, 0, 0, 2],
    ep: [8, 1, 2, 3, 11, 5, 6, 7, 4, 9, 10, 0],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    centers: IDENTITY_CENTERS,
  },
  F: {
    cp: [1, 5, 2, 3, 0, 4, 6, 7],
    co: [1, 2, 0, 0, 2, 1, 0, 0],
    ep: [0, 9, 2, 3, 4, 8, 6, 7, 1, 5, 10, 11],
    eo: [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0],
    centers: IDENTITY_CENTERS,
  },
  B: {
    cp: [0, 1, 3, 7, 4, 5, 2, 6],
    co: [0, 0, 1, 2, 0, 0, 2, 1],
    ep: [0, 1, 2, 11, 4, 5, 6, 10, 8, 9, 3, 7],
    eo: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1],
    centers: IDENTITY_CENTERS,
  },
  // Slices leave every corner alone, cycle the four edges of their layer and
  // flip all four, and carry four centers with them. M follows L, E follows D
  // and S follows F, which is the standard reading of the notation.
  M: {
    cp: IDENTITY_CORNERS,
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [0, 3, 2, 7, 4, 1, 6, 5, 8, 9, 10, 11],
    eo: [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0],
    centers: [5, 1, 0, 2, 4, 3],
  },
  E: {
    cp: IDENTITY_CORNERS,
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 8],
    eo: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    centers: [0, 2, 4, 3, 5, 1],
  },
  S: {
    cp: IDENTITY_CORNERS,
    co: [0, 0, 0, 0, 0, 0, 0, 0],
    ep: [2, 1, 6, 3, 0, 5, 4, 7, 8, 9, 10, 11],
    eo: [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
    centers: [4, 0, 2, 1, 3, 5],
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

/** The 18 face turns. Slices are deliberately absent: see {@link FaceMove}. */
export const ALL_HTM_MOVES: readonly FaceMove[] = Object.freeze(
  FACES.flatMap(
    (face): FaceMove[] => [
      Object.freeze({ face, turns: 1 }),
      Object.freeze({ face, turns: 3 }),
      Object.freeze({ face, turns: 2 }),
    ],
  ),
);

export function isFace(value: unknown): value is Face {
  return typeof value === 'string' && FACE_SET.has(value);
}

export function isSlice(value: unknown): value is Slice {
  return typeof value === 'string' && SLICE_SET.has(value);
}

export function isLayer(value: unknown): value is Layer {
  return isFace(value) || isSlice(value);
}

function isTurnCount(value: unknown): value is TurnCount {
  return value === 1 || value === 2 || value === 3;
}

export function isMove(value: unknown): value is Move {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Move>;
  return isLayer(candidate.face) && isTurnCount(candidate.turns);
}

/** Narrower than {@link isMove}: rejects the three slices. */
export function isFaceMove(value: unknown): value is FaceMove {
  return isMove(value) && isFace(value.face);
}

export function assertMove(value: unknown): asserts value is Move {
  if (!isMove(value)) {
    throw new TypeError(
      'Move must have a layer in U/D/L/R/F/B/M/E/S and turns of 1, 2, or 3',
    );
  }
}

export function assertFaceMove(value: unknown): asserts value is FaceMove {
  assertMove(value);
  if (!isFace(value.face)) {
    throw new TypeError(`Move must turn a face, not the ${value.face} slice`);
  }
}

export function layerAxis(layer: Layer): FaceAxis {
  return LAYER_AXES[layer];
}

export function oppositeFace(face: Face): Face {
  return OPPOSITE_FACES[face];
}

/**
 * Whether two layers move disjoint cubies, and so may turn at the same time.
 *
 * Before slices existed this was just "opposite faces", and only two layers
 * could ever run together. R, M and L are pairwise disjoint, so an axis now
 * carries up to three simultaneous turns.
 */
export function layersAreDisjoint(left: Layer, right: Layer): boolean {
  return left !== right && LAYER_AXES[left] === LAYER_AXES[right];
}

export function parseMove(token: string, tokenIndex = 0): Move {
  const match = /^([UDLRFBMES])([2']?)$/.exec(token);
  if (match === null) throw new MoveParseError(token, tokenIndex);

  const face = match[1] as Layer;
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

/**
 * Collapses turns of the same layer that nothing between them can disturb.
 *
 * Two layers on the same axis commute, so a move can reach back past any number
 * of them to meet an earlier turn of its own layer. `R U R' U'` has nothing to
 * collapse; `R L R2` is `R' L`, and `U D U2` is `U' D`.
 *
 * A two-phase solver needs this on its way out. Each phase forbids repeating a
 * layer inside itself, but the phase boundary resets that filter, so a solution
 * legitimately arrives as `R` followed by `R2` rather than as `R'`.
 *
 * The single pass is enough because the output it builds never holds two turns
 * of one layer separated only by commuting ones — merging one keeps that true,
 * so nothing new becomes reducible behind it.
 */
export function cancelMoves(moves: readonly Move[]): Move[] {
  const reduced: Move[] = [];
  for (const move of moves) {
    assertMove(move);
    let index = reduced.length - 1;
    while (index >= 0 && layersAreDisjoint(reduced[index]!.face, move.face)) {
      index -= 1;
    }

    if (index < 0 || reduced[index]!.face !== move.face) {
      // Nothing to meet, or something on another axis blocks the way back.
      reduced.push({ face: move.face, turns: move.turns });
      continue;
    }

    const turns = (reduced[index]!.turns + move.turns) % 4;
    if (turns === 0) reduced.splice(index, 1);
    else reduced[index] = { face: move.face, turns: turns as TurnCount };
  }
  return reduced;
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
  readonly centers: Uint8Array;
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
  const centers = new Uint8Array(CENTER_COUNT);

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

  // Centers carry no orientation, so this is a plain permutation compose.
  for (let position = 0; position < CENTER_COUNT; position += 1) {
    centers[position] = first.centers[second.centers[position]!]!;
  }

  return { cp, co, ep, eo, centers };
}

function compileMoveTable(layer: Layer): Readonly<Record<TurnCount, CompiledTransform>> {
  const source = QUARTER_TURNS[layer];
  const quarter: CompiledTransform = {
    cp: Uint8Array.from(source.cp),
    co: Uint8Array.from(source.co),
    ep: Uint8Array.from(source.ep),
    eo: Uint8Array.from(source.eo),
    centers: Uint8Array.from(source.centers),
  };
  const half = composeTransforms(quarter, quarter);
  return Object.freeze({ 1: quarter, 2: half, 3: composeTransforms(half, quarter) });
}

/**
 * All 27 moves precomposed at load. A half turn or a counter-clockwise turn
 * then costs one pass instead of repeating the quarter turn two or three times.
 */
const MOVE_TRANSFORMS: Readonly<
  Record<Layer, Readonly<Record<TurnCount, CompiledTransform>>>
> = Object.freeze(
  Object.fromEntries(LAYERS.map((layer) => [layer, compileMoveTable(layer)])) as Record<
    Layer,
    Readonly<Record<TurnCount, CompiledTransform>>
  >,
);

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

  for (let position = 0; position < CENTER_COUNT; position += 1) {
    target.centers[position] = source.centers[transform.centers[position]!]!;
  }
}

/** Zeroed buffers shaped like a state. Only ever handed to `applyTransform`. */
function allocateState(): CubeState {
  return {
    cp: new Uint8Array(CORNER_COUNT),
    co: new Uint8Array(CORNER_COUNT),
    ep: new Uint8Array(EDGE_COUNT),
    eo: new Uint8Array(EDGE_COUNT),
    centers: new Uint8Array(CENTER_COUNT),
  };
}

function copyStateInto(target: CubeState, source: CubeState): void {
  target.cp.set(source.cp);
  target.co.set(source.co);
  target.ep.set(source.ep);
  target.eo.set(source.eo);
  target.centers.set(source.centers);
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
