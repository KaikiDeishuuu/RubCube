import {
  applyMove,
  cancelMoves,
  invertMoves,
  type Face,
  type FaceMove,
  type Move,
} from '../moves.js';
import { assertValidState, invertState, type CubeState } from '../state.js';
import {
  COORDINATE_SIZES,
  HTM_V1_MOVE_ORDER,
  PHASE2_MOVE_ORDER,
  isCanonicalFaceSuccessor,
} from './constants.js';
import {
  rankCornerOrientation,
  rankCornerPermutation,
  rankEdgeOrientation,
  rankSlicePermutation,
  rankUDEdgePermutation,
  rankUDSlice,
} from './coordinates.js';
import {
  orientationOf,
  relabelFaceMoves,
  searchAxisFrames,
  toStandardOrientation,
} from './orientation.js';
import type { SolverTables } from './tables.js';

/**
 * Kociemba two-phase search (DESIGN-SOLVING.md 2.5).
 *
 * Phase 1 walks the cube into G1 = <U, D, L2, R2, F2, B2> in at most 12 moves;
 * phase 2 finishes inside G1 in at most 18. Neither half's search space fits a
 * pruning table on its own — the split is the whole trick.
 *
 * The kernel keeps its own stacks rather than recursing. A resumable search is
 * a requirement, not a nicety: the worker has to hand the event loop back on a
 * fixed node boundary to stay cancellable, and a generator-per-node would put
 * an allocation on the hottest path in the program. Pausing changes neither the
 * traversal order nor the node count, so a paused run and a straight-through
 * run return the same answer.
 */

const PHASE1_MOVE_COUNT = HTM_V1_MOVE_ORDER.length;
const PHASE2_MOVE_COUNT = PHASE2_MOVE_ORDER.length;

/** Guaranteed reach of each half, and therefore of the two together. */
const PHASE1_MAX_DEPTH = 12;
const PHASE2_MAX_DEPTH = 18;
export const TWO_PHASE_MAX_LENGTH = PHASE1_MAX_DEPTH + PHASE2_MAX_DEPTH;

/** Product goal, not a completeness bound: 30 is what the split guarantees. */
export const DEFAULT_TARGET_LENGTH = 21;

/**
 * The node budget the committed measurement profiles run under.
 *
 * Sized so the budget is not the binding constraint: a 300-state sample of
 * uniform random cubes peaked at 15.0M nodes, and the 10,000-state acceptance
 * corpus at 20.2M, so this sits about three times above anything measured. A
 * corpus state that exhausts it is a result to report, not a number to raise
 * afterwards — which is why it is declared here, beside the other profile
 * parameters and under version control, rather than in whichever script is
 * running. It is deliberately *not* part of SOLVER_FINGERPRINT: the fingerprint
 * versions the search's behaviour, and a budget changes how far it gets, not
 * what it does.
 */
export const BENCH_SOLVER_NODE_BUDGET = 64_000_000;

const UD_SLICE_SIZE = COORDINATE_SIZES.UDSlice;
const SLICE_PERM_SIZE = COORDINATE_SIZES.SlicePerm;

const PHASE1_CO_UD_SLICE_ENTRIES = COORDINATE_SIZES.CO * UD_SLICE_SIZE;
const PHASE1_EO_UD_SLICE_ENTRIES = COORDINATE_SIZES.EO * UD_SLICE_SIZE;
const PHASE2_CP_SLICE_ENTRIES = COORDINATE_SIZES.CP * SLICE_PERM_SIZE;
const PHASE2_UD_EDGE_SLICE_ENTRIES = COORDINATE_SIZES.UDEdgePerm * SLICE_PERM_SIZE;

/** Reserved by the nibble packing for "never reached by the generating BFS". */
const PRUNING_UNVISITED = 0x0f;

/** How often the wall clock is read, in counted nodes. */
const CLOCK_CHECK_INTERVAL = 1_024;

/** Nodes per slice of work when the whole search is driven in one call. */
const DEFAULT_CHUNK_NODES = 200_000;

/**
 * Nodes one direction runs before the other gets a turn.
 *
 * Small enough that a direction which finishes quickly is not left waiting
 * behind one that will not, large enough that the hand-off is noise next to the
 * ~24M nodes a second the inner loop sustains.
 */
const VARIANT_SLICE_NODES = 2_048;

/**
 * When the search widens from two directions to all six frames.
 *
 * Breadth is not free: six searches sharing a budget reach any one answer at a
 * third of the rate two do, which would push the median well past where it sits
 * now. The extra frames only pay on the states that are slow, so they are held
 * back until the search has shown itself to be one of those. The median solve
 * finishes inside 631k nodes, so a million is past the point where the first
 * two directions are still the better bet.
 */
const ESCALATION_NODES = 1_000_000;

export interface SolveOptions {
  /** Completeness bound on total length; defaults to 30. */
  readonly hardMax?: number;
  /** Stop as soon as a solution this short is found; defaults to 21. */
  readonly targetLength?: number;
  /** The deterministic budget. Every expanded DFS node counts against it. */
  readonly maxNodes?: number;
  /** Wall-clock fuse for interactive callers. Never a benchmark input. */
  readonly budgetMs?: number;
  /** Injectable clock; production reads the platform's monotonic source. */
  readonly now?: () => number;
}

export type SolveResult =
  | {
      readonly status: 'solved';
      readonly moves: readonly FaceMove[];
      readonly targetMet: boolean;
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'budget-exhausted';
      readonly best: readonly FaceMove[] | null;
      readonly reason: 'max-nodes' | 'deadline';
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'no-solution-within-hard-max';
      readonly nodes: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'cancelled';
      readonly nodes: number;
      readonly elapsedMs: number;
    };

export interface SolveSession {
  /** Counted nodes so far. Never exceeds `maxNodes`. */
  readonly nodes: number;
  /**
   * Runs about `chunkNodes` more nodes.
   *
   * Returns null while the search is still going, so a worker can hand the
   * event loop back between calls and answer a cancel or a newer request.
   */
  step(chunkNodes?: number): SolveResult | null;
  /** Ends the search now, reporting what it had counted. */
  cancel(): SolveResult;
}

/**
 * The platform's monotonic clock where there is one.
 *
 * Reached through globalThis because cube-core carries neither DOM nor Node
 * type libraries: it is the same engine in a browser, a worker and a bench
 * process, and none of those may be assumed.
 */
function defaultNow(): number {
  const timing = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof timing?.now === 'function' ? timing.now() : Date.now();
}

/**
 * Which moves may follow which, flattened for the inner loop.
 *
 * `isCanonicalFaceSuccessor` compares face letters; doing that per candidate
 * would put string comparison inside the hottest loop in the search. Row 0 is
 * the phase root, where anything may come first.
 */
function buildSuccessorMask(order: readonly Readonly<Move>[]): Uint8Array {
  const count = order.length;
  const mask = new Uint8Array((count + 1) * count);
  for (let previous = -1; previous < count; previous += 1) {
    const previousFace: Face | null =
      previous === -1 ? null : (order[previous]!.face as Face);
    for (let next = 0; next < count; next += 1) {
      mask[(previous + 1) * count + next] = isCanonicalFaceSuccessor(
        previousFace,
        order[next]!.face as Face,
      )
        ? 1
        : 0;
    }
  }
  return mask;
}

const PHASE1_SUCCESSORS = buildSuccessorMask(HTM_V1_MOVE_ORDER);
const PHASE2_SUCCESSORS = buildSuccessorMask(PHASE2_MOVE_ORDER);

function assertPruningTable(
  table: Uint8Array,
  entryCount: number,
  name: string,
): void {
  if (!(table instanceof Uint8Array) || table.length !== Math.ceil(entryCount / 2)) {
    throw new RangeError(`Pruning table ${name} does not match its specification`);
  }
}

function assertMoveTable(
  table: Uint16Array,
  entryCount: number,
  name: string,
): void {
  if (!(table instanceof Uint16Array) || table.length !== entryCount) {
    throw new RangeError(`Move table ${name} does not match its specification`);
  }
}

/** What one direction's search has to say after a slice of work. */
type VariantOutcome = 'running' | 'target-met' | 'complete';

/**
 * One direction's two-phase search, in the standard orientation only.
 *
 * Owns no budget and reads no clock: a driver runs several of these against a
 * shared budget, so a limit enforced in here would be spent several times over.
 *
 * Orientation is the driver's job too, and has to be. Inverting a state whose
 * centres are rotated does not commute with rotating it back: the search
 * returns the solved cube *rotated*, not the solved cube with rotated centres,
 * so `invertMoves` of an answer found in a rotated frame solves a conjugate of
 * the cube rather than the cube.
 */
class TwoPhaseSearch {
  private readonly moveCo: Uint16Array;
  private readonly moveEo: Uint16Array;
  private readonly moveUdSlice: Uint16Array;
  private readonly moveCp: Uint16Array;
  private readonly moveUdEdge: Uint16Array;
  private readonly moveSlicePerm: Uint16Array;
  private readonly pruneCoUdSlice: Uint8Array;
  private readonly pruneEoUdSlice: Uint8Array;
  private readonly pruneCpSlice: Uint8Array;
  private readonly pruneUdEdgeSlice: Uint8Array;

  private readonly hardMax: number;
  private readonly targetLength: number;

  /** Centres are home here; the driver rotated them before handing this over. */
  private readonly standard: CubeState;

  private readonly p1Co = new Int32Array(PHASE1_MAX_DEPTH + 1);
  private readonly p1Eo = new Int32Array(PHASE1_MAX_DEPTH + 1);
  private readonly p1Slice = new Int32Array(PHASE1_MAX_DEPTH + 1);
  private readonly p1Next = new Int32Array(PHASE1_MAX_DEPTH + 1);
  private readonly p1Path = new Int32Array(PHASE1_MAX_DEPTH);

  private readonly p2Cp = new Int32Array(PHASE2_MAX_DEPTH + 1);
  private readonly p2UdEdge = new Int32Array(PHASE2_MAX_DEPTH + 1);
  private readonly p2Slice = new Int32Array(PHASE2_MAX_DEPTH + 1);
  private readonly p2Next = new Int32Array(PHASE2_MAX_DEPTH + 1);
  private readonly p2Path = new Int32Array(PHASE2_MAX_DEPTH);

  private mode: 'phase1' | 'phase2' = 'phase1';
  private phase1Limit: number;
  private readonly phase1MaxLimit: number;
  private phase1Open = false;
  private p1Depth = 0;

  private phase2Limit = 0;
  private phase2MaxLimit = 0;
  private phase2Open = false;
  private p2Depth = 0;
  /** Length of the phase-1 solution the current phase-2 search hangs off. */
  private phase1Length = 0;

  /** The shortest candidate so far, in the standard frame and already reduced. */
  private best: FaceMove[] | null = null;
  private outcome: VariantOutcome = 'running';
  private nodeCount = 0;

  constructor(
    state: CubeState,
    tables: SolverTables,
    hardMax: number,
    targetLength: number,
  ) {
    this.hardMax = hardMax;
    this.targetLength = targetLength;

    const { moveTables, pruningTables } = tables;
    assertMoveTable(moveTables.co, COORDINATE_SIZES.CO * PHASE1_MOVE_COUNT, 'co');
    assertMoveTable(moveTables.eo, COORDINATE_SIZES.EO * PHASE1_MOVE_COUNT, 'eo');
    assertMoveTable(moveTables.udSlice, UD_SLICE_SIZE * PHASE1_MOVE_COUNT, 'udSlice');
    assertMoveTable(moveTables.cp, COORDINATE_SIZES.CP * PHASE2_MOVE_COUNT, 'cp');
    assertMoveTable(
      moveTables.udEdgePerm,
      COORDINATE_SIZES.UDEdgePerm * PHASE2_MOVE_COUNT,
      'udEdgePerm',
    );
    assertMoveTable(moveTables.slicePerm, SLICE_PERM_SIZE * PHASE2_MOVE_COUNT, 'slicePerm');
    assertPruningTable(pruningTables.coUDSlice, PHASE1_CO_UD_SLICE_ENTRIES, 'coUDSlice');
    assertPruningTable(pruningTables.eoUDSlice, PHASE1_EO_UD_SLICE_ENTRIES, 'eoUDSlice');
    assertPruningTable(pruningTables.cpSlicePerm, PHASE2_CP_SLICE_ENTRIES, 'cpSlicePerm');
    assertPruningTable(
      pruningTables.udEdgePermSlicePerm,
      PHASE2_UD_EDGE_SLICE_ENTRIES,
      'udEdgePermSlicePerm',
    );

    this.moveCo = moveTables.co;
    this.moveEo = moveTables.eo;
    this.moveUdSlice = moveTables.udSlice;
    this.moveCp = moveTables.cp;
    this.moveUdEdge = moveTables.udEdgePerm;
    this.moveSlicePerm = moveTables.slicePerm;
    this.pruneCoUdSlice = pruningTables.coUDSlice;
    this.pruneEoUdSlice = pruningTables.eoUDSlice;
    this.pruneCpSlice = pruningTables.cpSlicePerm;
    this.pruneUdEdgeSlice = pruningTables.udEdgePermSlicePerm;

    this.standard = state;

    this.phase1MaxLimit = Math.min(PHASE1_MAX_DEPTH, hardMax);
    this.phase1Limit = Math.max(
      this.phase1Heuristic(
        rankCornerOrientation(this.standard.co),
        rankEdgeOrientation(this.standard.eo),
        rankUDSlice(this.standard.ep),
      ),
      0,
    );
  }

  get nodes(): number {
    return this.nodeCount;
  }

  /** The shortest solution found so far, in the standard frame. */
  get bestSolution(): readonly FaceMove[] | null {
    return this.best;
  }

  step(chunkNodes: number): VariantOutcome {
    if (this.outcome !== 'running') return this.outcome;
    const stopAt = this.nodeCount + Math.max(1, chunkNodes);
    while (this.nodeCount < stopAt) {
      const done = this.mode === 'phase2' ? this.stepPhase2() : this.stepPhase1();
      if (done !== null) {
        this.outcome = done;
        return done;
      }
    }
    return 'running';
  }

  /** Distance lower bound to G1, from the better of the two phase-1 tables. */
  private phase1Heuristic(co: number, eo: number, slice: number): number {
    const first = this.readNibble(this.pruneCoUdSlice, co * UD_SLICE_SIZE + slice);
    const second = this.readNibble(this.pruneEoUdSlice, eo * UD_SLICE_SIZE + slice);
    return first > second ? first : second;
  }

  /** Distance lower bound to solved inside G1. */
  private phase2Heuristic(cp: number, udEdge: number, slice: number): number {
    const first = this.readNibble(this.pruneCpSlice, cp * SLICE_PERM_SIZE + slice);
    const second = this.readNibble(
      this.pruneUdEdgeSlice,
      udEdge * SLICE_PERM_SIZE + slice,
    );
    return first > second ? first : second;
  }

  /**
   * Unpacks one four-bit distance.
   *
   * Deliberately not `readPruningDistance`: that validates the table and the
   * index on every call, which is right for a public API and wrong for a
   * function the search calls four times per node. The tables were checked once
   * in the constructor instead. The unvisited sentinel is still checked,
   * because reading one means the search reached a coordinate pair the
   * generating BFS never did — a corrupt table would otherwise show up as a
   * wrong answer rather than an error.
   */
  private readNibble(table: Uint8Array, index: number): number {
    const packed = table[index >>> 1]!;
    const value = (index & 1) === 0 ? packed & 0x0f : packed >>> 4;
    if (value === PRUNING_UNVISITED) {
      throw new Error(`Pruning table has no distance for coordinate ${index}`);
    }
    return value;
  }

  private stepPhase1(): VariantOutcome | null {
    if (!this.phase1Open) {
      if (this.phase1Limit > this.phase1MaxLimit) return this.finish();

      // "Every iterative-deepening root entry into the DFS counts one."
      this.nodeCount += 1;
      this.p1Depth = 0;
      this.p1Co[0] = rankCornerOrientation(this.standard.co);
      this.p1Eo[0] = rankEdgeOrientation(this.standard.eo);
      this.p1Slice[0] = rankUDSlice(this.standard.ep);
      this.p1Next[0] = 0;
      this.phase1Open = true;

      if (this.phase1Limit === 0) {
        // The empty phase-1 solution: the cube is already in G1.
        this.closePhase1Iteration();
        if (this.phase1Heuristic(this.p1Co[0]!, this.p1Eo[0]!, this.p1Slice[0]!) === 0) {
          return this.enterPhase2(0);
        }
      }
      return null;
    }

    if (this.p1Depth < 0) {
      this.closePhase1Iteration();
      return null;
    }

    const depth = this.p1Depth;
    if (this.p1Next[depth]! >= PHASE1_MOVE_COUNT) {
      this.p1Depth -= 1;
      return null;
    }

    const moveIndex = this.p1Next[depth]!;
    this.p1Next[depth] = moveIndex + 1;
    const previous = depth === 0 ? -1 : this.p1Path[depth - 1]!;
    // Rejected candidates are not counted; only children that survive the
    // canonical filter are.
    if (PHASE1_SUCCESSORS[(previous + 1) * PHASE1_MOVE_COUNT + moveIndex] === 0) {
      return null;
    }

    this.nodeCount += 1;
    const co = this.moveCo[this.p1Co[depth]! * PHASE1_MOVE_COUNT + moveIndex]!;
    const eo = this.moveEo[this.p1Eo[depth]! * PHASE1_MOVE_COUNT + moveIndex]!;
    const slice =
      this.moveUdSlice[this.p1Slice[depth]! * PHASE1_MOVE_COUNT + moveIndex]!;
    const childDepth = depth + 1;
    if (childDepth + this.phase1Heuristic(co, eo, slice) > this.phase1Limit) {
      return null;
    }

    this.p1Path[depth] = moveIndex;
    if (childDepth === this.phase1Limit) {
      // Surviving the bound at the frontier means the heuristic was zero, and
      // a zero from both tables is exactly membership of G1.
      return this.enterPhase2(childDepth);
    }

    this.p1Depth = childDepth;
    this.p1Co[childDepth] = co;
    this.p1Eo[childDepth] = eo;
    this.p1Slice[childDepth] = slice;
    this.p1Next[childDepth] = 0;
    return null;
  }

  private closePhase1Iteration(): void {
    this.phase1Open = false;
    this.phase1Limit += 1;
  }

  /**
   * Hands one phase-1 solution to phase 2.
   *
   * The phase-2 start coordinates come from the cubie state with the phase-1
   * moves applied, rather than from tracking them through phase 1: they are not
   * defined until the cube is in G1, so there is nothing to track.
   */
  private enterPhase2(length: number): VariantOutcome | null {
    let mid = this.standard;
    for (let index = 0; index < length; index += 1) {
      mid = applyMove(mid, HTM_V1_MOVE_ORDER[this.p1Path[index]!]!);
    }

    const cp = rankCornerPermutation(mid.cp);
    const udEdge = rankUDEdgePermutation(mid.ep);
    const slice = rankSlicePermutation(mid.ep);

    if (cp === 0 && udEdge === 0 && slice === 0) {
      return this.record(length, 0);
    }

    const bestBound =
      this.best === null ? PHASE2_MAX_DEPTH : this.best.length - length - 1;
    const limit = Math.min(PHASE2_MAX_DEPTH, this.hardMax - length, bestBound);
    const heuristic = this.phase2Heuristic(cp, udEdge, slice);
    if (limit < heuristic) return null;

    this.phase1Length = length;
    this.phase2MaxLimit = limit;
    this.phase2Limit = heuristic;
    this.phase2Open = false;
    this.p2Cp[0] = cp;
    this.p2UdEdge[0] = udEdge;
    this.p2Slice[0] = slice;
    this.mode = 'phase2';
    return null;
  }

  private stepPhase2(): VariantOutcome | null {
    if (!this.phase2Open) {
      if (this.phase2Limit > this.phase2MaxLimit) {
        this.mode = 'phase1';
        return null;
      }
      this.nodeCount += 1;
      this.p2Depth = 0;
      this.p2Next[0] = 0;
      this.phase2Open = true;
      return null;
    }

    if (this.p2Depth < 0) {
      this.phase2Open = false;
      this.phase2Limit += 1;
      return null;
    }

    const depth = this.p2Depth;
    if (this.p2Next[depth]! >= PHASE2_MOVE_COUNT) {
      this.p2Depth -= 1;
      return null;
    }

    const moveIndex = this.p2Next[depth]!;
    this.p2Next[depth] = moveIndex + 1;
    const previous = depth === 0 ? -1 : this.p2Path[depth - 1]!;
    if (PHASE2_SUCCESSORS[(previous + 1) * PHASE2_MOVE_COUNT + moveIndex] === 0) {
      return null;
    }

    this.nodeCount += 1;
    const cp = this.moveCp[this.p2Cp[depth]! * PHASE2_MOVE_COUNT + moveIndex]!;
    const udEdge =
      this.moveUdEdge[this.p2UdEdge[depth]! * PHASE2_MOVE_COUNT + moveIndex]!;
    const slice =
      this.moveSlicePerm[this.p2Slice[depth]! * PHASE2_MOVE_COUNT + moveIndex]!;
    const childDepth = depth + 1;
    if (childDepth + this.phase2Heuristic(cp, udEdge, slice) > this.phase2Limit) {
      return null;
    }

    this.p2Path[depth] = moveIndex;
    if (childDepth === this.phase2Limit) {
      return this.record(this.phase1Length, childDepth);
    }

    this.p2Depth = childDepth;
    this.p2Cp[childDepth] = cp;
    this.p2UdEdge[childDepth] = udEdge;
    this.p2Slice[childDepth] = slice;
    this.p2Next[childDepth] = 0;
    return null;
  }

  /**
   * Keeps a finished candidate, and stops if it already meets the target.
   *
   * The two halves are joined and then reduced. Each phase forbids repeating a
   * layer inside itself, but the boundary resets that filter, so `R` from phase
   * 1 followed by `R2` from phase 2 arrives as two moves for what is one.
   *
   * Lengths are compared after reduction, which makes the `limit2` bound below
   * slightly conservative: a phase-2 tail that would have reduced under the
   * current best can be cut before it is tried. That costs the occasional
   * shorter solution and never a correct one; the optimal solver is M3c.
   */
  private record(phase1Length: number, phase2Length: number): VariantOutcome | null {
    const joined: Move[] = [];
    for (let index = 0; index < phase1Length; index += 1) {
      joined.push(HTM_V1_MOVE_ORDER[this.p1Path[index]!]!);
    }
    for (let index = 0; index < phase2Length; index += 1) {
      joined.push(PHASE2_MOVE_ORDER[this.p2Path[index]!]!);
    }
    const candidate = cancelMoves(joined) as FaceMove[];

    if (this.best === null || candidate.length < this.best.length) {
      this.best = candidate;
    }
    // Back to enumerating phase-1 solutions: a longer phase-2 tail off this
    // same prefix cannot beat what was just recorded.
    this.mode = 'phase1';
    this.phase2Open = false;

    return this.best.length <= this.targetLength ? 'target-met' : null;
  }

  private finish(): VariantOutcome {
    return 'complete';
  }
}

/**
 * Runs both directions of the same cube against one budget.
 *
 * A cube and its inverse are different search problems, and often wildly
 * different ones: the hardest states measured here took 900ms forwards and
 * 52ms backwards. Which direction is the easy one is not knowable in advance,
 * so both run, taking turns, and the first to meet the target wins.
 *
 * The budget, the clock and cancellation live here rather than in the searches,
 * because a limit enforced inside each of them would be spent once per
 * direction. Turn order and slice size are fixed, so the node count is
 * reproducible.
 */
interface SearchVariant {
  readonly search: TwoPhaseSearch;
  /** Rewrites this variant's answer as a solution of the standard-frame cube. */
  readonly adapt: (moves: readonly FaceMove[]) => readonly FaceMove[];
}

class TwoPhaseDriver implements SolveSession {
  private readonly variants: SearchVariant[];
  private readonly live: boolean[];
  private readonly seedVariants: () => readonly SearchVariant[];
  private widened = false;
  private readonly targetLength: number;
  private readonly maxNodes: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly deadline: number;
  private readonly orientation: ReturnType<typeof orientationOf>;

  private turn = 0;
  private nodeCount = 0;
  private nextClockCheck = CLOCK_CHECK_INTERVAL;
  private cancelled = false;
  private finished: SolveResult | null = null;

  constructor(state: CubeState, tables: SolverTables, options: SolveOptions) {
    assertValidState(state);

    const hardMax = options.hardMax ?? TWO_PHASE_MAX_LENGTH;
    const targetLength =
      options.targetLength ?? Math.min(DEFAULT_TARGET_LENGTH, hardMax);
    if (!Number.isSafeInteger(hardMax) || hardMax < 0 || hardMax > TWO_PHASE_MAX_LENGTH) {
      throw new RangeError(`hardMax must be an integer in 0..${TWO_PHASE_MAX_LENGTH}`);
    }
    if (!Number.isSafeInteger(targetLength) || targetLength < 0 || targetLength > hardMax) {
      throw new RangeError('targetLength must be an integer in 0..hardMax');
    }
    if (
      options.maxNodes !== undefined &&
      (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 0)
    ) {
      throw new RangeError('maxNodes must be a non-negative integer');
    }
    if (
      options.budgetMs !== undefined &&
      (!Number.isFinite(options.budgetMs) || options.budgetMs < 0)
    ) {
      throw new RangeError('budgetMs must be a non-negative finite number');
    }

    this.targetLength = targetLength;
    this.maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? defaultNow;
    this.startedAt = this.now();
    this.deadline =
      options.budgetMs === undefined
        ? Number.POSITIVE_INFINITY
        : this.startedAt + options.budgetMs;

    // Rotate to standard once, here, and rename the answer on the way out.
    // Every variant then searches a cube whose centres are home, which is the
    // only frame in which inverting the state and inverting the solution are
    // the same operation.
    const standard = toStandardOrientation(state);
    this.orientation = standard.orientation;

    const directions = (
      base: CubeState,
      rename: (moves: readonly FaceMove[]) => readonly FaceMove[],
    ): SearchVariant[] => [
      {
        search: new TwoPhaseSearch(base, tables, hardMax, targetLength),
        adapt: rename,
      },
      {
        search: new TwoPhaseSearch(invertState(base), tables, hardMax, targetLength),
        // Solving the inverse produces the scramble; played backwards, it is
        // the solution.
        adapt: (moves) => rename(invertMoves(moves) as FaceMove[]),
      },
    ];

    this.variants = directions(standard.state, (moves) => moves);
    this.live = this.variants.map(() => true);
    this.seedVariants = () =>
      searchAxisFrames().flatMap((frame) =>
        directions(frame.conjugate(standard.state), (moves) =>
          relabelFaceMoves(moves, frame.toStandard),
        ),
      );
  }

  get nodes(): number {
    return this.nodeCount;
  }

  cancel(): SolveResult {
    this.cancelled = true;
    this.finished ??= {
      status: 'cancelled',
      nodes: this.nodeCount,
      elapsedMs: this.elapsed(),
    };
    return this.finished;
  }

  step(chunkNodes: number = DEFAULT_CHUNK_NODES): SolveResult | null {
    if (this.finished !== null) return this.finished;
    const stopAt = this.nodeCount + Math.max(1, chunkNodes);

    while (this.nodeCount < stopAt) {
      if (this.cancelled) return this.cancel();
      if (this.nodeCount >= this.maxNodes) return this.exhausted('max-nodes');
      if (this.nodeCount >= this.nextClockCheck) {
        this.nextClockCheck = this.nodeCount + CLOCK_CHECK_INTERVAL;
        if (this.now() >= this.deadline) return this.exhausted('deadline');
      }
      if (this.nodeCount >= ESCALATION_NODES) this.widen();
      if (!this.live.some(Boolean)) return this.finish();

      const index = this.nextLiveVariant();
      const variant = this.variants[index]!;
      // The slice is deliberately independent of the caller's chunk. Letting the
      // chunk shrink it would make the turn order depend on how often the
      // caller paused, and a paused search has to return what an unpaused one
      // would. The chunk only decides when this call hands control back, which
      // is why the loop may overshoot it by less than one slice.
      const slice = Math.min(VARIANT_SLICE_NODES, this.maxNodes - this.nodeCount);
      if (slice <= 0) return this.exhausted('max-nodes');

      const before = variant.search.nodes;
      const outcome = variant.search.step(slice);
      this.nodeCount += variant.search.nodes - before;

      if (outcome === 'target-met') return this.solvedBy(index);
      if (outcome === 'complete') this.live[index] = false;
    }
    return null;
  }

  /** Brings the rotated frames in, once the first two have proved slow. */
  private widen(): void {
    if (this.widened) return;
    this.widened = true;
    for (const variant of this.seedVariants()) {
      this.variants.push(variant);
      this.live.push(true);
    }
  }

  private nextLiveVariant(): number {
    for (let offset = 0; offset < this.variants.length; offset += 1) {
      const index = (this.turn + offset) % this.variants.length;
      if (this.live[index] === true) {
        this.turn = (index + 1) % this.variants.length;
        return index;
      }
    }
    throw new Error('No live search to advance');
  }

  private elapsed(): number {
    return this.now() - this.startedAt;
  }

  /** The shortest solution any direction has, already in the caller's frame. */
  private bestSoFar(): readonly FaceMove[] | null {
    let best: readonly FaceMove[] | null = null;
    for (const variant of this.variants) {
      const candidate = variant.search.bestSolution;
      if (candidate === null) continue;
      // Adapting cannot change the length, so comparing before adapting would
      // work too; adapting first keeps the comparison in the frame it is
      // reported in.
      const adapted = variant.adapt(candidate);
      if (best === null || adapted.length < best.length) best = adapted;
    }
    // Renaming happens once, at the boundary: everything above this line is in
    // the standard frame.
    return best === null
      ? null
      : Object.freeze(relabelFaceMoves(best, this.orientation));
  }

  private solvedBy(index: number): SolveResult {
    const variant = this.variants[index]!;
    if (variant.search.bestSolution === null) {
      throw new Error('A met target must have a solution');
    }
    // Another direction may already hold something shorter.
    const best = this.bestSoFar();
    if (best === null) throw new Error('A met target must have a solution');
    this.finished = {
      status: 'solved',
      moves: best,
      targetMet: true,
      nodes: this.nodeCount,
      elapsedMs: this.elapsed(),
    };
    return this.finished;
  }

  private exhausted(reason: 'max-nodes' | 'deadline'): SolveResult {
    this.finished = {
      status: 'budget-exhausted',
      best: this.bestSoFar(),
      reason,
      nodes: this.nodeCount,
      elapsedMs: this.elapsed(),
    };
    return this.finished;
  }

  private finish(): SolveResult {
    const best = this.bestSoFar();
    this.finished =
      best === null
        ? {
            status: 'no-solution-within-hard-max',
            nodes: this.nodeCount,
            elapsedMs: this.elapsed(),
          }
        : {
            status: 'solved',
            moves: best,
            targetMet: best.length <= this.targetLength,
            nodes: this.nodeCount,
            elapsedMs: this.elapsed(),
          };
    return this.finished;
  }
}

/** Starts a search that the caller drives, so it can be paused or cancelled. */
export function beginSolve(
  state: CubeState,
  tables: SolverTables,
  options: SolveOptions = {},
): SolveSession {
  return new TwoPhaseDriver(state, tables, options);
}

/** Runs a search to completion. */
export function solve(
  state: CubeState,
  tables: SolverTables,
  options: SolveOptions = {},
): SolveResult {
  const session = beginSolve(state, tables, options);
  for (;;) {
    const result = session.step();
    if (result !== null) return result;
  }
}
