import {
  applyMove,
  applyMoves,
  assertFaceMove,
  cancelMoves,
  invertMoves,
  type FaceMove,
} from '../moves.js';
import {
  CORNER_COUNT,
  EDGE_COUNT,
  assertValidState,
  createSolvedState,
  statesEqual,
  type CubeState,
} from '../state.js';
import { HTM_V1_MOVE_ORDER, buildSuccessorMask } from '../solver/constants.js';

/**
 * True HTM-optimal solving for cubes within nine moves of solved
 * (DESIGN-SOLVING.md 2.8).
 *
 * This is the ruler the two-phase solver is measured with, not a solver anyone
 * plays against: DESIGN.md 6.5's `optimality_ratio` needs a denominator that is
 * exactly the shortest solution, and the two-phase search cannot supply one.
 * Nine moves is where meet-in-the-middle stops being cheap, and it is far
 * enough to cover the short end of a benchmark corpus.
 *
 * Meet in the middle, not IDA*. IDA* would be correct with any admissible
 * bound — even a constant zero — so the choice is about work, not soundness. To
 * make IDA* fast enough at depth nine you need a real pattern database, and the
 * full corner one is 8! * 3^7 = 88,179,840 entries, about 42 MiB as nibbles.
 * Meeting in the middle reaches the same depth out of a 621,649-state ball, and
 * its work per solve grows predictably with distance rather than with how well
 * a heuristic happens to fit the cube in front of it.
 *
 * The module is Node-only by policy rather than by dependency: it imports
 * nothing platform-specific, but a ball plus its index is tens of megabytes and
 * has no business in a browser bundle. DESIGN-SOLVING.md 2.7 keeps it out of
 * one with a build assertion, which is why it lives outside `solver/` and is
 * published on its own `@rubcube/cube-core/optimal` subpath.
 */

const MOVE_COUNT = HTM_V1_MOVE_ORDER.length;
const SUCCESSORS = buildSuccessorMask(HTM_V1_MOVE_ORDER);

/**
 * The traversal order, narrowed to face turns.
 *
 * `HTM_V1_MOVE_ORDER` is typed over every layer because `Move` is; the assert
 * checks at load time what the name has always claimed, so the search can build
 * `FaceMove` results without a cast that would outlive the guarantee. A slice
 * turn appearing there would break this module outright — the ball is built
 * from face turns and could never contain the result.
 */
const ORDER: readonly FaceMove[] = Object.freeze(
  HTM_V1_MOVE_ORDER.map((move) => {
    assertFaceMove(move);
    return move;
  }),
);

/** The furthest this module solves. Past it, callers get an explicit refusal. */
export const MAX_OPTIMAL_DISTANCE = 9;

/**
 * `HTM_BALL_SIZES[r]` is the number of states within `r` face turns of solved.
 *
 * Published constants, reproduced here so a build of the ball can be checked
 * against them rather than trusted. The per-distance layer sizes are the
 * differences: 1, 18, 243, 3,240, 43,239, 574,908. A move table with a wrong
 * entry, or a state key that loses information, moves these numbers.
 */
export const HTM_BALL_SIZES: readonly number[] = Object.freeze([
  1, 19, 262, 3_502, 46_741, 621_649,
]);

/** See {@link buildSolvedBall} for the measurement behind this. */
export const DEFAULT_BALL_RADIUS = 5;

/**
 * Move tables in the same destination-indexed form {@link applyMove} uses,
 * flattened per move.
 *
 * Read off the public move engine rather than restated: applying move `m` to
 * the solved cube yields exactly the table `applyMove` would have used, because
 * every `cp[p]` starts equal to `p` and every twist starts at zero. Nothing
 * here can drift away from the rest of cube-core without a test that compares
 * cubies failing first.
 */
interface FlatMoveTables {
  readonly cp: Uint8Array;
  readonly co: Uint8Array;
  readonly ep: Uint8Array;
  readonly eo: Uint8Array;
}

function buildFlatMoveTables(): FlatMoveTables {
  const tables: FlatMoveTables = {
    cp: new Uint8Array(MOVE_COUNT * CORNER_COUNT),
    co: new Uint8Array(MOVE_COUNT * CORNER_COUNT),
    ep: new Uint8Array(MOVE_COUNT * EDGE_COUNT),
    eo: new Uint8Array(MOVE_COUNT * EDGE_COUNT),
  };
  const solved = createSolvedState();
  for (let move = 0; move < MOVE_COUNT; move += 1) {
    const turned = applyMove(solved, ORDER[move]!);
    tables.cp.set(turned.cp, move * CORNER_COUNT);
    tables.co.set(turned.co, move * CORNER_COUNT);
    tables.ep.set(turned.ep, move * EDGE_COUNT);
    tables.eo.set(turned.eo, move * EDGE_COUNT);
  }
  return tables;
}

const MOVES = buildFlatMoveTables();

/**
 * Four cubie arrays, kept apart from {@link CubeState} on purpose.
 *
 * The search never touches centres — face turns cannot move one — so carrying
 * them would be dead weight on every node, and the entry point rejects a cube
 * whose centres are not home rather than quietly solving a different problem.
 */
interface Cubies {
  readonly cp: Uint8Array;
  readonly co: Uint8Array;
  readonly ep: Uint8Array;
  readonly eo: Uint8Array;
}

function allocateCubies(): Cubies {
  return {
    cp: new Uint8Array(CORNER_COUNT),
    co: new Uint8Array(CORNER_COUNT),
    ep: new Uint8Array(EDGE_COUNT),
    eo: new Uint8Array(EDGE_COUNT),
  };
}

/** `target = source` turned by move `m`, with no allocation and no validation. */
function turn(target: Cubies, source: Cubies, move: number): void {
  const cornerBase = move * CORNER_COUNT;
  for (let position = 0; position < CORNER_COUNT; position += 1) {
    const from = MOVES.cp[cornerBase + position]!;
    target.cp[position] = source.cp[from]!;
    const twist = source.co[from]! + MOVES.co[cornerBase + position]!;
    target.co[position] = twist > 2 ? twist - 3 : twist;
  }

  const edgeBase = move * EDGE_COUNT;
  for (let position = 0; position < EDGE_COUNT; position += 1) {
    const from = MOVES.ep[edgeBase + position]!;
    target.ep[position] = source.ep[from]!;
    target.eo[position] = (source.eo[from]! + MOVES.eo[edgeBase + position]!) & 1;
  }
}

/**
 * The four words that identify a state, packed by {@link packKey}.
 *
 * "Hash table" must not be read as licence to allow collisions: the cube group
 * has 4.3e19 elements, so no 64-bit number can name them all, and two states
 * sharing a slot would hand back a solution for the wrong cube. Every stored
 * word is compared on a hit; the hash only chooses where to look.
 *
 * The packing is the raw arrays, not a rank. Ranks would be tighter — a
 * permutation of twelve carries 29 bits, not 48 — but injectivity here holds
 * for any values inside the declared ranges rather than only for physically
 * valid cubes, and that is a claim with no precondition to get wrong.
 */
const KEY_WORDS = 4;

function packKey(cubies: Cubies, out: Uint32Array): void {
  let corners = 0;
  let twists = 0;
  for (let position = 0; position < CORNER_COUNT; position += 1) {
    corners |= cubies.cp[position]! << (position * 3);
    twists |= cubies.co[position]! << (position * 2);
  }

  let lowEdges = 0;
  let highEdges = 0;
  let flips = 0;
  for (let position = 0; position < 8; position += 1) {
    lowEdges |= cubies.ep[position]! << (position * 4);
  }
  for (let position = 8; position < EDGE_COUNT; position += 1) {
    highEdges |= cubies.ep[position]! << ((position - 8) * 4);
  }
  for (let position = 0; position < EDGE_COUNT; position += 1) {
    flips |= cubies.eo[position]! << position;
  }

  out[0] = corners >>> 0;
  out[1] = twists >>> 0;
  out[2] = lowEdges >>> 0;
  out[3] = (highEdges | (flips << 16)) >>> 0;
}

/** Avalanche over all four words; xorshift-multiply in the style of xxHash. */
function hashKey(w0: number, w1: number, w2: number, w3: number): number {
  let hash = Math.imul(w0 ^ 0x9e37_79b1, 0x85eb_ca6b);
  hash = Math.imul((hash >>> 13) ^ w1, 0xc2b2_ae35);
  hash = Math.imul((hash >>> 15) ^ w2, 0x27d4_eb2f);
  hash = Math.imul((hash >>> 13) ^ w3, 0x1656_67b1);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Smallest power of two that keeps the load factor under a quarter. */
function indexCapacity(entryCount: number): number {
  let capacity = 16;
  while (capacity < entryCount * 4) capacity *= 2;
  return capacity;
}

/**
 * Every state within `radius` face turns of solved, with a shortest path back.
 *
 * Build it once and hand it to every solve: it is the expensive half, and it
 * does not depend on the cube being solved.
 */
export interface SolvedBall {
  readonly radius: number;
  /** Total states held. Equals `HTM_BALL_SIZES[radius]`. */
  readonly size: number;
  /** Exactly how many states sit at each distance 0..radius. */
  readonly layerSizes: readonly number[];
  /**
   * The shortest move sequence taking solved to `state`, or null if it is
   * further away than `radius`.
   */
  pathTo(state: CubeState): FaceMove[] | null;
}

/**
 * An interior view of the ball, so the search can look a state up without
 * building a {@link CubeState} for it.
 */
interface BallIndex extends SolvedBall {
  /** Entry index for packed key words at `probe[0..3]`, or -1. */
  find(probe: Uint32Array): number;
  /** The shortest move sequence from solved to entry `entry`. */
  pathFrom(entry: number): FaceMove[];
}

/**
 * Breadth-first search out from solved, keeping every state's exact distance.
 *
 * Expanded with all eighteen moves rather than the canonical subset. The subset
 * would also be complete, but "complete" there rests on an argument about
 * reduced sequences, and the whole point of this table is to be the thing other
 * arguments are checked against. Deduplication by state does the pruning that
 * matters, and the cost is paid once.
 *
 * Radius is the whole performance decision, because it is the reverse search
 * that has to make up the difference. DESIGN-SOLVING.md 2.8 wrote the split as
 * four and five; measured over 200 nine-move scrambles per side, five and four
 * is about ten times faster:
 *
 * | radius | ball    | build  | memory | nine-move solve p50 | refusal p50 |
 * |--------|---------|--------|--------|---------------------|-------------|
 * | 4      | 46,741  |  17 ms |  2 MB  |             59.7 ms |    106.5 ms |
 * | 5      | 621,649 | 233 ms | 31 MB  |              6.2 ms |     11.2 ms |
 *
 * Five pays for its build after four hard solves, which a corpus reaches
 * immediately, so it is the default. Four stays available and tested: the two
 * must agree on every distance, and that they do is the cross-check that a
 * single radius could not give.
 */
export function buildSolvedBall(radius: number = DEFAULT_BALL_RADIUS): SolvedBall {
  if (!Number.isInteger(radius) || radius < 0 || radius >= HTM_BALL_SIZES.length) {
    throw new RangeError(
      `Ball radius must be an integer in 0..${HTM_BALL_SIZES.length - 1}`,
    );
  }

  const expected = HTM_BALL_SIZES[radius]!;
  const keys = new Uint32Array(expected * KEY_WORDS);
  // No depth column: an entry's distance from solved is the length of its
  // parent chain, and storing it as well would be a second copy of the same
  // fact for something only the BFS's own level boundaries ever needed.
  const parents = new Int32Array(expected);
  const parentMoves = new Int8Array(expected);

  const capacity = indexCapacity(expected);
  const mask = capacity - 1;
  // Zero means empty, so slots hold entry + 1.
  const slots = new Int32Array(capacity);

  const layerSizes: number[] = [];
  let size = 0;

  function insert(probe: Uint32Array): number {
    const w0 = probe[0]!;
    const w1 = probe[1]!;
    const w2 = probe[2]!;
    const w3 = probe[3]!;
    let slot = hashKey(w0, w1, w2, w3) & mask;
    for (;;) {
      const held = slots[slot]!;
      if (held === 0) break;
      const base = (held - 1) * KEY_WORDS;
      if (
        keys[base] === w0 &&
        keys[base + 1] === w1 &&
        keys[base + 2] === w2 &&
        keys[base + 3] === w3
      ) {
        return -1;
      }
      slot = (slot + 1) & mask;
    }

    if (size >= expected) {
      // Reaching here means the BFS found more states than the published ball
      // size, so something below it — a move table, the key packing — is wrong.
      throw new Error(
        `Ball of radius ${radius} exceeded its published size of ${expected}`,
      );
    }
    const entry = size;
    size += 1;
    const base = entry * KEY_WORDS;
    keys[base] = w0;
    keys[base + 1] = w1;
    keys[base + 2] = w2;
    keys[base + 3] = w3;
    slots[slot] = entry + 1;
    return entry;
  }

  function find(probe: Uint32Array): number {
    const w0 = probe[0]!;
    const w1 = probe[1]!;
    const w2 = probe[2]!;
    const w3 = probe[3]!;
    let slot = hashKey(w0, w1, w2, w3) & mask;
    for (;;) {
      const held = slots[slot]!;
      if (held === 0) return -1;
      const base = (held - 1) * KEY_WORDS;
      if (
        keys[base] === w0 &&
        keys[base + 1] === w1 &&
        keys[base + 2] === w2 &&
        keys[base + 3] === w3
      ) {
        return held - 1;
      }
      slot = (slot + 1) & mask;
    }
  }

  const probe = new Uint32Array(KEY_WORDS);
  const source = allocateCubies();
  const child = allocateCubies();

  const solved = createSolvedState();
  source.cp.set(solved.cp);
  source.ep.set(solved.ep);
  packKey(source, probe);
  const root = insert(probe);
  parents[root] = -1;
  parentMoves[root] = -1;
  layerSizes.push(1);

  let layerStart = 0;
  for (let depth = 0; depth < radius; depth += 1) {
    const layerEnd = size;
    for (let entry = layerStart; entry < layerEnd; entry += 1) {
      const base = entry * KEY_WORDS;
      unpackKey(keys, base, source);
      for (let move = 0; move < MOVE_COUNT; move += 1) {
        turn(child, source, move);
        packKey(child, probe);
        const added = insert(probe);
        if (added < 0) continue;
        parents[added] = entry;
        parentMoves[added] = move;
      }
    }
    layerSizes.push(size - layerEnd);
    layerStart = layerEnd;
  }

  if (size !== expected) {
    throw new Error(
      `Ball of radius ${radius} holds ${size} states, expected ${expected}`,
    );
  }

  function pathFrom(entry: number): FaceMove[] {
    const reversed: FaceMove[] = [];
    for (let cursor = entry; parents[cursor]! >= 0; cursor = parents[cursor]!) {
      const move = ORDER[parentMoves[cursor]!]!;
      reversed.push({ face: move.face, turns: move.turns });
    }
    return reversed.reverse();
  }

  const scratch = allocateCubies();
  const lookup = new Uint32Array(KEY_WORDS);

  const ball: BallIndex = {
    radius,
    size,
    layerSizes: Object.freeze([...layerSizes]),
    find,
    pathFrom,
    pathTo(state: CubeState): FaceMove[] | null {
      assertValidState(state);
      if (!centresAreHome(state)) return null;
      scratch.cp.set(state.cp);
      scratch.co.set(state.co);
      scratch.ep.set(state.ep);
      scratch.eo.set(state.eo);
      packKey(scratch, lookup);
      const entry = find(lookup);
      return entry < 0 ? null : pathFrom(entry);
    },
  };
  return Object.freeze(ball);
}

/** Reverses {@link packKey}, for walking a BFS layer back out of storage. */
function unpackKey(keys: Uint32Array, base: number, out: Cubies): void {
  const corners = keys[base]!;
  const twists = keys[base + 1]!;
  for (let position = 0; position < CORNER_COUNT; position += 1) {
    out.cp[position] = (corners >>> (position * 3)) & 0x7;
    out.co[position] = (twists >>> (position * 2)) & 0x3;
  }

  const lowEdges = keys[base + 2]!;
  const packed = keys[base + 3]!;
  for (let position = 0; position < 8; position += 1) {
    out.ep[position] = (lowEdges >>> (position * 4)) & 0xf;
  }
  for (let position = 8; position < EDGE_COUNT; position += 1) {
    out.ep[position] = (packed >>> ((position - 8) * 4)) & 0xf;
  }
  const flips = packed >>> 16;
  for (let position = 0; position < EDGE_COUNT; position += 1) {
    out.eo[position] = (flips >>> position) & 1;
  }
}

function centresAreHome(state: CubeState): boolean {
  for (let position = 0; position < state.centers.length; position += 1) {
    if (state.centers[position] !== position) return false;
  }
  return true;
}

/** Raised for a cube this module declines to interpret, rather than mis-solve. */
export class RotatedCubeError extends RangeError {
  constructor() {
    super(
      'Optimal solving needs the centres at home: face turns cannot move a ' +
        'centre, so a rotated cube has a different target and a different ' +
        'shortest solution',
    );
    this.name = 'RotatedCubeError';
  }
}

export interface OptimalSolveOptions {
  /** A ball to reuse. Built and cached at the default radius when absent. */
  readonly ball?: SolvedBall;
  /** Injectable clock; production reads the platform's monotonic source. */
  readonly now?: () => number;
}

export type OptimalSolveResult =
  | {
      readonly status: 'optimal';
      /** Shortest HTM solution. Empty exactly when the cube is already solved. */
      readonly moves: readonly FaceMove[];
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      /** Further from solved than this module reaches; no solution was found. */
      readonly status: 'beyond-reach';
      /** Every state at distance `limit` or less was ruled out. */
      readonly limit: number;
      readonly nodes: number;
      readonly elapsedMs: number;
    };

function defaultNow(): number {
  const timing = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof timing?.now === 'function' ? timing.now() : Date.now();
}

/**
 * Checks the answer against the move engine before it leaves the module.
 *
 * The search reaches its result through packed keys, a hash index and a parent
 * chain, and a fault in any of them shows up as a plausible-looking sequence
 * rather than as a crash. Some of those faults cannot be provoked from outside
 * — a key that dropped a component only mis-answers for two cubes that collide
 * in the index, which no scramble produces on purpose. Replaying the moves
 * costs a few microseconds next to a search that just expanded a hundred
 * thousand nodes, and it is the difference between a wrong benchmark
 * denominator and a stack trace.
 *
 * Minimality gets the same treatment. The two halves meet under different move
 * filters, so the join could in principle hold a reducible pair; at the optimum
 * it cannot, because a shorter equivalent would contradict the length just
 * proved minimal. The check is what turns that reasoning into an assertion.
 */
function assertSolution(state: CubeState, moves: readonly FaceMove[]): void {
  if (!statesEqual(applyMoves(state, moves), createSolvedState())) {
    throw new Error('Optimal search returned a sequence that does not solve the cube');
  }
  if (cancelMoves(moves).length !== moves.length) {
    throw new Error('Optimal solution reduces further: the search is unsound');
  }
}

let cachedBall: SolvedBall | null = null;

/** The shared default-radius ball, built on first use. */
export function solvedBall(): SolvedBall {
  cachedBall ??= buildSolvedBall(DEFAULT_BALL_RADIUS);
  return cachedBall;
}

/**
 * The shortest HTM solution, or an explicit refusal when there is none within
 * {@link MAX_OPTIMAL_DISTANCE}.
 *
 * Iterative deepening from the scrambled cube, testing each frontier state
 * against the ball. Call the true distance `d`. No iteration shallower than
 * `d - radius` can hit: a hit at reverse depth `j` on a ball entry at depth `f`
 * *is* a solution of length `j + f`, so finding one below `d` would contradict
 * `d` being shortest. Iteration `d - radius` must hit, because the state
 * `radius` moves from the end of any shortest solution sits in the ball by
 * definition. So the first iteration that hits is `d - radius`, and every hit
 * it finds has `j + f` between `d - radius` and `d` — which leaves only `d`.
 * That is why the search can stop at the first hit instead of finishing the
 * iteration, and why only frontier states need testing.
 */
export function solveOptimal(
  state: CubeState,
  options: OptimalSolveOptions = {},
): OptimalSolveResult {
  assertValidState(state);
  if (!centresAreHome(state)) throw new RotatedCubeError();

  const ball = (options.ball ?? solvedBall()) as BallIndex;
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const maxReverseDepth = MAX_OPTIMAL_DISTANCE - ball.radius;

  // One state per level, reused across iterations; the DFS is at most nine deep
  // and never holds a sibling, so the whole search allocates a fixed handful of
  // arrays before it starts and none after.
  const stack: Cubies[] = [];
  for (let level = 0; level <= maxReverseDepth; level += 1) stack.push(allocateCubies());
  const path = new Int8Array(Math.max(1, maxReverseDepth));
  const probe = new Uint32Array(KEY_WORDS);

  const root = stack[0]!;
  root.cp.set(state.cp);
  root.co.set(state.co);
  root.ep.set(state.ep);
  root.eo.set(state.eo);

  let nodes = 0;
  let meet = -1;
  let meetDepth = 0;

  function descend(depth: number, limit: number, previous: number): boolean {
    if (depth === limit) {
      packKey(stack[depth]!, probe);
      const entry = ball.find(probe);
      if (entry < 0) return false;
      meet = entry;
      meetDepth = depth;
      return true;
    }

    const row = (previous + 1) * MOVE_COUNT;
    for (let move = 0; move < MOVE_COUNT; move += 1) {
      if (SUCCESSORS[row + move] === 0) continue;
      nodes += 1;
      turn(stack[depth + 1]!, stack[depth]!, move);
      path[depth] = move;
      if (descend(depth + 1, limit, move)) return true;
    }
    return false;
  }

  for (let limit = 0; limit <= maxReverseDepth; limit += 1) {
    // Matches the two-phase search's convention: entering an iterative-
    // deepening iteration is itself one node.
    nodes += 1;
    if (descend(0, limit, -1)) {
      const backward: FaceMove[] = [];
      for (let step = 0; step < meetDepth; step += 1) {
        const move = ORDER[path[step]!]!;
        backward.push({ face: move.face, turns: move.turns });
      }
      const moves = [...backward, ...invertMoves(ball.pathFrom(meet))] as FaceMove[];
      assertSolution(state, moves);
      return {
        status: 'optimal',
        moves,
        nodes,
        elapsedMs: now() - startedAt,
      };
    }
  }

  return {
    status: 'beyond-reach',
    limit: MAX_OPTIMAL_DISTANCE,
    nodes,
    elapsedMs: now() - startedAt,
  };
}
