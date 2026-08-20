import { beforeAll, describe, expect, it } from 'vitest';

import {
  applyMoves,
  parseMoves,
  serializeMoves,
  type FaceMove,
} from '../src/moves.js';
import { generateRandomMoves } from '../src/scramble.js';
import {
  cloneState,
  createSolvedState,
  isSolved,
  statesEqual,
  type CubeState,
} from '../src/state.js';
import { relabelFaceMoves, searchAxisFrames } from '../src/solver/orientation.js';
import {
  DEFAULT_TARGET_LENGTH,
  TWO_PHASE_MAX_LENGTH,
  beginSolve,
  solve,
  type SolveResult,
} from '../src/solver/search.js';
import { generateSolverTables, type SolverTables } from '../src/solver/tables.js';

let tables: SolverTables;

beforeAll(() => {
  tables = generateSolverTables();
}, 120_000);

const SOLVED = createSolvedState();

function scrambled(seed: number, length = 25): CubeState {
  return applyMoves(SOLVED, generateRandomMoves(length, seed));
}

/** A state that no short search will crack, for budget and limit tests. */
function hard(): CubeState {
  return scrambled(60);
}

/** Axis rotations spelled out in the move vocabulary the engine accepts. */
const ROTATIONS: Readonly<Record<string, string>> = Object.freeze({
  x: "R M' L'",
  "x'": "R' M L",
  x2: 'R2 M2 L2',
  y: "U E' D'",
  "y'": "U' E D",
  y2: 'U2 E2 D2',
  z: "F S B'",
  "z'": "F' S' B",
  z2: 'F2 S2 B2',
});

function rotationMoves(notation: string): ReturnType<typeof parseMoves> {
  if (notation === '') return [];
  return parseMoves(
    notation
      .split(' ')
      .map((token) => ROTATIONS[token] ?? token)
      .join(' '),
  );
}

function expectSolves(state: CubeState, moves: readonly FaceMove[]): void {
  expect(isSolved(applyMoves(state, moves))).toBe(true);
}

describe('two-phase search', () => {
  it('solves a seeded corpus and leaves every input untouched', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const state = scrambled(seed);
      const before = cloneState(state);
      const result = solve(state, tables);

      expect(result.status).toBe('solved');
      if (result.status !== 'solved') continue;
      expectSolves(state, result.moves);
      expect(result.moves.length).toBeLessThanOrEqual(DEFAULT_TARGET_LENGTH);
      // The worker protocol hands the caller's own arrays across; a search that
      // wrote to them would corrupt the store the solve was requested from.
      expect(statesEqual(state, before)).toBe(true);
    }
  }, 300_000);

  it('returns an empty solution for a cube that is already solved', () => {
    const result = solve(SOLVED, tables);
    expect(result).toMatchObject({ status: 'solved', targetMet: true });
    if (result.status !== 'solved') return;
    expect(result.moves).toEqual([]);
  });

  it('collapses a solution the phase boundary split in two', () => {
    // Each phase forbids repeating a face inside itself, but the boundary
    // resets that, so this arrives as `R` then `R2` before it is reduced.
    const result = solve(applyMoves(SOLVED, parseMoves('R')), tables);
    expect(result.status).toBe('solved');
    if (result.status !== 'solved') return;
    expect(serializeMoves(result.moves)).toBe("R'");
  });

  it('solves a cube in every one of the 24 whole-cube orientations', () => {
    // Face turns cannot move a centre, so these only have a solution at all
    // because the search rotates to standard and renames its answer back.
    //
    // Every orientation, not a sample: rotating and inverting do not commute,
    // and the first version of this got the wrong answer for some orientations
    // while looking correct for others.
    const rotations = ['', 'x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];
    const seen = new Set<string>();
    for (const first of rotations) {
      for (const second of rotations) {
        const rotated = applyMoves(SOLVED, rotationMoves(`${first} ${second}`.trim()));
        seen.add([...rotated.centers].join(','));
        const state = applyMoves(rotated, parseMoves("R U R' U' F2 L D"));
        const result = solve(state, tables);

        expect(result.status).toBe('solved');
        if (result.status !== 'solved') continue;
        expectSolves(state, result.moves);
        // Playable as handed over: a slice would move a centre and undo this.
        for (const move of result.moves) {
          expect(['U', 'D', 'L', 'R', 'F', 'B']).toContain(move.face);
        }
        // Centres cannot be turned by the solution, so they must come out of it
        // exactly as they went in.
        expect([...applyMoves(state, result.moves).centers]).toEqual([
          ...rotated.centers,
        ]);
      }
    }
    expect(seen.size).toBe(24);
  }, 300_000);
});

describe('axis frames', () => {
  it('renames an answer found in a frame back into a real solution', () => {
    // The driver widens into these frames on slow states, so a relabel in the
    // wrong direction would produce a plausible sequence that solves a
    // conjugate of the cube rather than the cube — and only sometimes, which is
    // exactly how the first version of the inverse variant got through review.
    for (const frame of searchAxisFrames()) {
      for (let seed = 0; seed < 12; seed += 1) {
        const state = scrambled(seed, 12);
        const inFrame = frame.conjugate(state);
        const found = solve(inFrame, tables);

        expect(found.status).toBe('solved');
        if (found.status !== 'solved') continue;
        // It solves the conjugated cube, which is not the one we asked about.
        expectSolves(inFrame, found.moves);
        // Renamed, it solves the one we did.
        expectSolves(state, relabelFaceMoves(found.moves, frame.toStandard));
      }
    }
  }, 120_000);
});

describe('the four outcomes stay distinct', () => {
  it('reports no solution when the length limit forbids one', () => {
    const result = solve(hard(), tables, { hardMax: 5, targetLength: 5 });
    expect(result.status).toBe('no-solution-within-hard-max');
  });

  it('reports an exhausted budget with nothing found', () => {
    const result = solve(hard(), tables, { maxNodes: 40 });
    expect(result).toMatchObject({ status: 'budget-exhausted', reason: 'max-nodes' });
    if (result.status !== 'budget-exhausted') return;
    // An empty array would claim the cube was already solved.
    expect(result.best).toBeNull();
    expect(result.nodes).toBeLessThanOrEqual(40);
  });

  it('keeps the best solution it had when the budget ran out', () => {
    // A target no solution can meet keeps the search going until the budget
    // stops it, by which time it has candidates worth returning.
    const state = hard();
    const result = solve(state, tables, { targetLength: 0, maxNodes: 1_500_000 });
    expect(result).toMatchObject({ status: 'budget-exhausted', reason: 'max-nodes' });
    if (result.status !== 'budget-exhausted') return;
    expect(result.best).not.toBeNull();
    expectSolves(state, result.best!);
  });

  it('reports a deadline separately from a node budget', () => {
    const result = solve(hard(), tables, { targetLength: 0, budgetMs: 20 });
    expect(result).toMatchObject({ status: 'budget-exhausted', reason: 'deadline' });
  });

  it('reports cancellation, and keeps reporting it', () => {
    const session = beginSolve(hard(), tables, { targetLength: 0 });
    session.step(5_000);
    const cancelled = session.cancel();
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(session.step(5_000)).toMatchObject({ status: 'cancelled' });
  });

  it('rejects an invalid state rather than returning a status', () => {
    expect(() => solve({} as never, tables)).toThrow();
    const broken = cloneState(SOLVED);
    broken.cp[0] = 7;
    expect(() => solve(broken, tables)).toThrow();
  });

  it('rejects options that cannot describe a search', () => {
    for (const options of [
      { hardMax: -1 },
      { hardMax: TWO_PHASE_MAX_LENGTH + 1 },
      { hardMax: 2.5 },
      { targetLength: -1 },
      { hardMax: 10, targetLength: 11 },
      { maxNodes: -1 },
      { maxNodes: 1.5 },
      { budgetMs: -1 },
      { budgetMs: Number.NaN },
    ]) {
      expect(() => solve(SOLVED, tables, options)).toThrow(RangeError);
    }
  });

  it('rejects tables that do not match their specification', () => {
    const broken = {
      ...tables,
      moveTables: { ...tables.moveTables, co: new Uint16Array(4) },
    };
    expect(() => solve(SOLVED, broken, {})).toThrow(RangeError);
  });
});

describe('reproducibility', () => {
  function fingerprint(result: SolveResult): string {
    const moves =
      result.status === 'solved'
        ? serializeMoves(result.moves)
        : result.status === 'budget-exhausted' && result.best !== null
          ? serializeMoves(result.best)
          : '';
    return `${result.status}|${result.nodes}|${moves}`;
  }

  it('gives the same answer and the same node count every time', () => {
    // No deadline and no cancellation: the two conditions under which the
    // profile promises repeatability.
    const state = scrambled(41);
    const options = { hardMax: 30, targetLength: 21, maxNodes: 3_000_000 };
    const first = fingerprint(solve(state, tables, options));
    for (let repeat = 0; repeat < 9; repeat += 1) {
      expect(fingerprint(solve(state, tables, options))).toBe(first);
    }
  }, 120_000);

  it('is unchanged by how often the caller pauses it', () => {
    // The worker pauses on a node boundary to stay cancellable. If that changed
    // the turn order between the two directions it would change the answer.
    const state = scrambled(60);
    const options = { targetLength: 21, maxNodes: 3_000_000 };
    const straight = fingerprint(solve(state, tables, options));

    for (const chunk of [1, 97, 2_048, 50_000]) {
      const session = beginSolve(state, tables, options);
      let result: SolveResult | null = null;
      while (result === null) result = session.step(chunk);
      expect(fingerprint(result)).toBe(straight);
      expect(session.nodes).toBe(result.nodes);
    }
  }, 120_000);

  it('never counts more nodes than the budget allows', () => {
    for (const maxNodes of [0, 1, 7, 2_049, 100_000]) {
      const result = solve(hard(), tables, { maxNodes, targetLength: 0 });
      expect(result.nodes).toBeLessThanOrEqual(maxNodes);
    }
  });
});
