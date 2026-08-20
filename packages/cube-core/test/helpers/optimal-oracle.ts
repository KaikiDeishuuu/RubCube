import {
  ALL_HTM_MOVES,
  applyMove,
  createSolvedState,
  type CubeState,
  type FaceMove,
} from '../../src/index.js';

/**
 * An optimal-distance oracle sharing nothing with the module it checks.
 *
 * `bidirectional.ts` is where optimality is claimed, so nothing from it may be
 * borrowed to confirm the claim. This reaches for the public move engine and
 * standard-library containers only: no packed keys, no flat move tables, no
 * canonical successor mask, no parent chains. What is left in common is the
 * idea of meeting in the middle, and a bug in any of the parts listed above
 * changes this oracle's answer or the module's, but not both.
 */

const SOLVED_KEY = keyOf(createSolvedState());

/** Lossless: forty cubie values, each already a distinct code unit. */
function keyOf(state: CubeState): string {
  return String.fromCharCode(...state.cp, ...state.co, ...state.ep, ...state.eo);
}

export interface OptimalOracle {
  readonly radius: number;
  /** Exact distance for states inside the ball, else null. */
  distanceWithin(state: CubeState): number | null;
  /** Exact distance up to `radius + reverseDepth`, else null. */
  distance(state: CubeState, reverseDepth: number): number | null;
}

/**
 * Breadth-first from solved, recording each state's exact distance.
 *
 * Radius five is 621,649 states; six would be 8.2 million, which is where a
 * `Map` of strings stops being reasonable. Distances past five come from
 * meeting this ball in the middle instead.
 */
export function buildOptimalOracle(radius = 5): OptimalOracle {
  const distances = new Map<string, number>();
  distances.set(SOLVED_KEY, 0);

  let frontier: CubeState[] = [createSolvedState()];
  for (let depth = 0; depth < radius; depth += 1) {
    const next: CubeState[] = [];
    for (const state of frontier) {
      for (const move of ALL_HTM_MOVES) {
        const child = applyMove(state, move);
        const key = keyOf(child);
        if (distances.has(key)) continue;
        distances.set(key, depth + 1);
        next.push(child);
      }
    }
    frontier = next;
  }

  function distanceWithin(state: CubeState): number | null {
    return distances.get(keyOf(state)) ?? null;
  }

  /**
   * The minimum of `walked + distance(reached)` over every reverse path.
   *
   * Deliberately the full minimum rather than the first hit: the module under
   * test stops early on an argument about which iteration can hit first, and an
   * oracle that made the same argument would not be checking it.
   *
   * The only pruning is "never turn the same face twice in a row", which no
   * shortest solution does — two turns of one face collapse into at most one.
   */
  function distance(state: CubeState, reverseDepth: number): number | null {
    let best: number | null = distanceWithin(state);

    const walk = (current: CubeState, walked: number, previous: string): void => {
      if (walked === reverseDepth) return;
      for (const move of ALL_HTM_MOVES) {
        if (move.face === previous) continue;
        const child = applyMove(current, move);
        const reached = distances.get(keyOf(child));
        if (reached !== undefined) {
          const total = walked + 1 + reached;
          if (best === null || total < best) best = total;
        }
        walk(child, walked + 1, move.face);
      }
    };

    walk(state, 0, '');
    return best;
  }

  return { radius, distanceWithin, distance };
}

/** Convenience for corpus generation: scrambles of exactly `length` moves. */
export function scrambleFrom(moves: readonly FaceMove[]): CubeState {
  let state = createSolvedState();
  for (const move of moves) state = applyMove(state, move);
  return state;
}
