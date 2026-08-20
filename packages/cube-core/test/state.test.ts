import { describe, expect, it } from 'vitest';

import { applyMoves, invertMoves, parseMoves } from '../src/moves.js';
import {
  CORNER_NAMES,
  CubeStateValidationError,
  EDGE_NAMES,
  assertValidState,
  cloneState,
  composeStates,
  createSolvedState,
  invertState,
  isSolved,
  isValidState,
  statesEqual,
  validateState,
  type CubeState,
  type CubeStateComponent,
} from '../src/state.js';

function codes(state: unknown): string[] {
  return validateState(state).map((issue) => issue.code);
}

describe('CubeState', () => {
  it('publishes the canonical Kociemba cubie order', () => {
    expect(CORNER_NAMES).toEqual(['URF', 'UFL', 'ULB', 'UBR', 'DFR', 'DLF', 'DBL', 'DRB']);
    expect(EDGE_NAMES).toEqual([
      'UR',
      'UF',
      'UL',
      'UB',
      'DR',
      'DF',
      'DL',
      'DB',
      'FR',
      'FL',
      'BL',
      'BR',
    ]);
  });

  it('creates a valid solved state backed by typed arrays', () => {
    const state = createSolvedState();

    expect(state.cp).toBeInstanceOf(Uint8Array);
    expect(state.co).toBeInstanceOf(Uint8Array);
    expect(state.ep).toBeInstanceOf(Uint8Array);
    expect(state.eo).toBeInstanceOf(Uint8Array);
    expect([...state.cp]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...state.co]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...state.ep]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect([...state.eo]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(validateState(state)).toEqual([]);
    expect(isValidState(state)).toBe(true);
    expect(isSolved(state)).toBe(true);
    expect(() => assertValidState(state)).not.toThrow();
  });

  it('does not share mutable storage between solved states', () => {
    const first = createSolvedState();
    const second = createSolvedState();

    expect(first.cp).not.toBe(second.cp);
    expect(first.co).not.toBe(second.co);
    expect(first.ep).not.toBe(second.ep);
    expect(first.eo).not.toBe(second.eo);

    first.co[0] = 1;
    expect(second.co[0]).toBe(0);
  });

  it('deep-clones state and compares all components by value', () => {
    const source = createSolvedState();
    const copy = cloneState(source);

    expect(statesEqual(source, copy)).toBe(true);
    expect(copy.cp).not.toBe(source.cp);
    expect(copy.co).not.toBe(source.co);
    expect(copy.ep).not.toBe(source.ep);
    expect(copy.eo).not.toBe(source.eo);

    copy.co[0] = 1;
    expect(statesEqual(source, copy)).toBe(false);
    expect(source.co[0]).toBe(0);
  });

  it.each([
    ['cp', 1],
    ['co', 1],
    ['ep', 1],
    ['eo', 1],
  ] as const)('detects a difference in %s', (component, value) => {
    const left = createSolvedState();
    const right = createSolvedState();
    right[component][0] = value;

    expect(statesEqual(left, right)).toBe(false);
    expect(isSolved(right)).toBe(false);
  });

  it('returns false for solved-shaped arrays with a wrong length', () => {
    const state = createSolvedState();
    state.cp = state.cp.slice(0, 7);

    expect(isSolved(state)).toBe(false);
  });
});

describe('state legality', () => {
  it('accepts a non-solved state satisfying all four invariants', () => {
    const state = createSolvedState();
    [state.cp[0], state.cp[1]] = [state.cp[1]!, state.cp[0]!];
    [state.ep[0], state.ep[1]] = [state.ep[1]!, state.ep[0]!];
    state.co[0] = 1;
    state.co[1] = 2;
    state.eo[0] = 1;
    state.eo[1] = 1;

    expect(isSolved(state)).toBe(false);
    expect(validateState(state)).toEqual([]);
    expect(isValidState(state)).toBe(true);
  });

  it('rejects a non-object state', () => {
    expect(validateState(null)).toEqual([
      expect.objectContaining({ code: 'INVALID_STATE_TYPE' }),
    ]);
  });

  it('requires every component to be a Uint8Array', () => {
    const state = { ...createSolvedState(), cp: [0, 1, 2, 3, 4, 5, 6, 7] };

    expect(validateState(state)).toEqual([
      expect.objectContaining({ code: 'INVALID_COMPONENT_TYPE', component: 'cp' }),
    ]);
  });

  it.each([
    ['cp', 7, 8],
    ['co', 7, 8],
    ['ep', 11, 12],
    ['eo', 11, 12],
  ] as const)('checks the length of %s', (component, actual, expected) => {
    const state = createSolvedState();
    state[component] = state[component].slice(0, actual);

    expect(validateState(state)).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_LENGTH',
        component,
        actual,
        expected,
      }),
    );
  });

  it.each([
    ['cp', 8, 7],
    ['co', 3, 2],
    ['ep', 12, 11],
    ['eo', 2, 1],
  ] as const)(
    'checks the value range of %s',
    (component: CubeStateComponent, value, maximum) => {
      const state = createSolvedState();
      state[component][0] = value;

      expect(validateState(state)).toContainEqual(
        expect.objectContaining({
          code: 'VALUE_OUT_OF_RANGE',
          component,
          index: 0,
          value,
          maximum,
        }),
      );
    },
  );

  it.each(['cp', 'ep'] as const)('requires %s to be a permutation', (component) => {
    const state = createSolvedState();
    state[component][0] = 1;

    expect(validateState(state)).toContainEqual(
      expect.objectContaining({
        code: 'INVALID_PERMUTATION',
        component,
        duplicateValues: [1],
        missingValues: [0],
      }),
    );
  });

  it('enforces the corner-orientation sum', () => {
    const state = createSolvedState();
    state.co[0] = 1;

    expect(codes(state)).toContain('CORNER_ORIENTATION_SUM');
  });

  it('enforces the edge-orientation sum', () => {
    const state = createSolvedState();
    state.eo[0] = 1;

    expect(codes(state)).toContain('EDGE_ORIENTATION_SUM');
  });

  it('enforces matching corner and edge permutation parity', () => {
    const state = createSolvedState();
    [state.cp[0], state.cp[1]] = [state.cp[1]!, state.cp[0]!];

    expect(validateState(state)).toContainEqual(
      expect.objectContaining({
        code: 'PERMUTATION_PARITY_MISMATCH',
        cornerParity: 1,
        edgeParity: 0,
      }),
    );
  });

  it('reports independent invariant failures together', () => {
    const state = createSolvedState();
    state.co[0] = 1;
    state.eo[0] = 1;

    expect(codes(state)).toEqual(
      expect.arrayContaining(['CORNER_ORIENTATION_SUM', 'EDGE_ORIENTATION_SUM']),
    );
  });

  it('throws a typed error carrying machine-readable issues', () => {
    const state = createSolvedState();
    state.eo[0] = 1;

    expect(() => assertValidState(state)).toThrow(CubeStateValidationError);

    try {
      assertValidState(state);
      throw new Error('expected assertValidState to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CubeStateValidationError);
      expect((error as CubeStateValidationError).issues).toContainEqual(
        expect.objectContaining({ code: 'EDGE_ORIENTATION_SUM' }),
      );
    }
  });

  it('classifies every corrupted component exactly as the diagnostic report does', () => {
    // isValidState runs an allocation-free fast path while validateState still
    // builds the issue list. Two implementations of one predicate must not be
    // allowed to drift, so check them against each other on every single-slot
    // corruption of each component, plus wrong lengths and non-states.
    const candidates: unknown[] = [
      null,
      undefined,
      42,
      'state',
      [],
      {},
      createSolvedState(),
    ];
    const components: readonly CubeStateComponent[] = ['cp', 'co', 'ep', 'eo'];

    for (const component of components) {
      const length = component === 'cp' || component === 'co' ? 8 : 12;

      for (let index = 0; index < length; index += 1) {
        for (const value of [0, 1, 2, 3, 7, 11, 12, 255]) {
          const corrupted = createSolvedState();
          corrupted[component][index] = value;
          candidates.push(corrupted);
        }
      }

      for (const wrongLength of [length - 1, length + 1]) {
        const resized = createSolvedState();
        resized[component] = new Uint8Array(wrongLength);
        candidates.push(resized);
      }

      const wrongType = createSolvedState();
      (wrongType as unknown as Record<string, unknown>)[component] = new Array(length).fill(0);
      candidates.push(wrongType);
    }

    expect(candidates.length).toBeGreaterThan(300);
    for (const candidate of candidates) {
      expect(isValidState(candidate)).toBe(validateState(candidate).length === 0);
    }
  });

  it('acts as a runtime type guard for unknown input', () => {
    const candidate: unknown = createSolvedState();

    assertValidState(candidate);
    const state: CubeState = candidate;
    expect(isSolved(state)).toBe(true);
  });
});

describe('state inverse', () => {
  it('composes with its own state to give the solved cube', () => {
    // A sequence and its reverse: applying the inverse state's defining moves
    // is the same as undoing the original.
    for (const notation of ["R U R' U'", "F2 L D B' R2", "M E' S2 R U", '']) {
      const moves = parseMoves(notation);
      const state = applyMoves(createSolvedState(), moves);
      const inverse = invertState(state);
      expect(statesEqual(inverse, applyMoves(createSolvedState(), invertMoves(moves)))).toBe(
        true,
      );
    }
  });

  it('is its own undo', () => {
    const state = applyMoves(createSolvedState(), parseMoves("R U2 D' B M' D'"));
    expect(statesEqual(invertState(invertState(state)), state)).toBe(true);
  });

  it('leaves the solved cube alone', () => {
    expect(statesEqual(invertState(createSolvedState()), createSolvedState())).toBe(true);
  });

  it('produces a valid state, centres included', () => {
    // The centre permutation has to invert too, or the result is not one of the
    // 24 orientations and validation rejects it.
    const state = applyMoves(createSolvedState(), parseMoves("M2 E S' R U F"));
    const inverse = invertState(state);
    expect(isValidState(inverse)).toBe(true);
    expect(validateState(inverse)).toEqual([]);
  });

  it('never touches the state it inverts', () => {
    const state = applyMoves(createSolvedState(), parseMoves("R U R' U'"));
    const before = cloneState(state);
    invertState(state);
    expect(statesEqual(state, before)).toBe(true);
  });

  it('rejects a state that is not valid', () => {
    expect(() => invertState({} as never)).toThrow();
  });
});


describe('state composition', () => {
  const solved = createSolvedState();
  const stateOf = (notation: string): CubeState =>
    applyMoves(solved, parseMoves(notation));

  it('is what applying one sequence after another means', () => {
    // The group operation has to agree with the move layer, or conjugation
    // built on it would quietly disagree with everything else.
    const first = "R U R' U'";
    const second = "F2 L D";
    expect(
      statesEqual(
        composeStates(stateOf(first), stateOf(second)),
        stateOf(`${first} ${second}`),
      ),
    ).toBe(true);
  });

  it('has the solved cube as its identity, on both sides', () => {
    const state = stateOf("R U2 D' B M' D'");
    expect(statesEqual(composeStates(solved, state), state)).toBe(true);
    expect(statesEqual(composeStates(state, solved), state)).toBe(true);
  });

  it('undoes a state when composed with its inverse', () => {
    for (const notation of ["R U R' U'", "M E' S2 R U", 'F']) {
      const state = stateOf(notation);
      expect(statesEqual(composeStates(state, invertState(state)), solved)).toBe(true);
      expect(statesEqual(composeStates(invertState(state), state), solved)).toBe(true);
    }
  });

  it('is associative', () => {
    const [a, b, c] = [stateOf('R U'), stateOf("F' D2"), stateOf("M2 L")];
    expect(
      statesEqual(
        composeStates(composeStates(a!, b!), c!),
        composeStates(a!, composeStates(b!, c!)),
      ),
    ).toBe(true);
  });

  it('produces a valid state and touches neither operand', () => {
    const [a, b] = [stateOf("R U R' M"), stateOf("E S' D2")];
    const [beforeA, beforeB] = [cloneState(a!), cloneState(b!)];
    const composed = composeStates(a!, b!);
    expect(validateState(composed)).toEqual([]);
    expect(statesEqual(a!, beforeA)).toBe(true);
    expect(statesEqual(b!, beforeB)).toBe(true);
  });

  it('rejects an operand that is not a state', () => {
    expect(() => composeStates(solved, {} as never)).toThrow();
    expect(() => composeStates({} as never, solved)).toThrow();
  });
});
