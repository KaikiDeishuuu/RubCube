/**
 * The canonical cubie ordering used throughout cube-core.
 *
 * This is Kociemba's ordering. Array indices in {@link CubeState} always refer
 * to positions in these tuples, and permutation values refer to cubies in the
 * same tuples.
 */
export const CORNER_NAMES = Object.freeze([
  'URF',
  'UFL',
  'ULB',
  'UBR',
  'DFR',
  'DLF',
  'DBL',
  'DRB',
] as const);

export const EDGE_NAMES = Object.freeze([
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
] as const);

/**
 * Center cubie order, matching the URFDLB facelet convention.
 *
 * Centers only became part of the state when slice moves arrived: face turns
 * leave all six fixed, but M, E and S each rotate four of them.
 */
export const CENTER_NAMES = Object.freeze([
  'U',
  'R',
  'F',
  'D',
  'L',
  'B',
] as const);

export const CORNER_COUNT = CORNER_NAMES.length;
export const EDGE_COUNT = EDGE_NAMES.length;
export const CENTER_COUNT = CENTER_NAMES.length;

export type CornerName = (typeof CORNER_NAMES)[number];
export type EdgeName = (typeof EDGE_NAMES)[number];
export type CenterName = (typeof CENTER_NAMES)[number];

/** The authoritative, cubie-level representation of a 3x3 cube. */
export interface CubeState {
  /** cp[i] is the corner cubie occupying corner position i (0..7). */
  cp: Uint8Array;
  /** Corner orientation at each position: 0, 1, or 2. */
  co: Uint8Array;
  /** ep[i] is the edge cubie occupying edge position i (0..11). */
  ep: Uint8Array;
  /** Edge orientation at each position: 0 or 1. */
  eo: Uint8Array;
  /** centers[i] is the center cubie occupying center position i (0..5). */
  centers: Uint8Array;
}

export type CubeStateComponent = keyof CubeState;
export type PermutationComponent = 'cp' | 'ep';

export type CubeStateValidationIssue =
  | {
      readonly code: 'INVALID_STATE_TYPE';
      readonly message: string;
    }
  | {
      readonly code: 'INVALID_CENTER_ROTATION';
      readonly message: string;
    }
  | {
      readonly code: 'INVALID_COMPONENT_TYPE';
      readonly component: CubeStateComponent;
      readonly message: string;
    }
  | {
      readonly code: 'INVALID_LENGTH';
      readonly component: CubeStateComponent;
      readonly expected: number;
      readonly actual: number;
      readonly message: string;
    }
  | {
      readonly code: 'VALUE_OUT_OF_RANGE';
      readonly component: CubeStateComponent;
      readonly index: number;
      readonly value: number;
      readonly minimum: number;
      readonly maximum: number;
      readonly message: string;
    }
  | {
      readonly code: 'INVALID_PERMUTATION';
      readonly component: PermutationComponent;
      readonly duplicateValues: readonly number[];
      readonly missingValues: readonly number[];
      readonly message: string;
    }
  | {
      readonly code: 'CORNER_ORIENTATION_SUM';
      readonly remainder: number;
      readonly message: string;
    }
  | {
      readonly code: 'EDGE_ORIENTATION_SUM';
      readonly remainder: number;
      readonly message: string;
    }
  | {
      readonly code: 'PERMUTATION_PARITY_MISMATCH';
      readonly cornerParity: 0 | 1;
      readonly edgeParity: 0 | 1;
      readonly centerParity: 0 | 1;
      readonly message: string;
    };

/** Thrown by {@link assertValidState} for a structurally or physically invalid state. */
export class CubeStateValidationError extends Error {
  readonly issues: readonly CubeStateValidationIssue[];

  constructor(issues: readonly CubeStateValidationIssue[]) {
    const detail = issues.map((issue) => issue.message).join('; ');
    super(detail.length > 0 ? `Invalid cube state: ${detail}` : 'Invalid cube state');
    this.name = 'CubeStateValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

interface ComponentSpec {
  readonly component: CubeStateComponent;
  readonly length: number;
  readonly maximum: number;
}

const COMPONENT_SPECS: readonly ComponentSpec[] = [
  { component: 'cp', length: CORNER_COUNT, maximum: CORNER_COUNT - 1 },
  { component: 'co', length: CORNER_COUNT, maximum: 2 },
  { component: 'ep', length: EDGE_COUNT, maximum: EDGE_COUNT - 1 },
  { component: 'eo', length: EDGE_COUNT, maximum: 1 },
  { component: 'centers', length: CENTER_COUNT, maximum: CENTER_COUNT - 1 },
];

/** Axis components of each center's home normal, in CENTER_NAMES order. */
const CENTER_NORMALS: readonly (readonly [number, number, number])[] = Object.freeze([
  Object.freeze([0, 1, 0] as const),
  Object.freeze([1, 0, 0] as const),
  Object.freeze([0, 0, 1] as const),
  Object.freeze([0, -1, 0] as const),
  Object.freeze([-1, 0, 0] as const),
  Object.freeze([0, 0, -1] as const),
]);

/** CENTER_NAMES pairs each face with its opposite exactly three apart. */
const OPPOSITE_CENTER_OFFSET = CENTER_COUNT / 2;

/**
 * Whether `centers` is one of the 24 orientations, not just any permutation.
 *
 * Only a whole-cube rotation can rearrange centers, so opposite positions must
 * still hold opposite cubies and the axes must keep their handedness. A
 * mirrored arrangement satisfies both the permutation and the opposite-pair
 * checks while being unreachable by any sequence of moves, so the handedness
 * test is what makes this exact rather than merely necessary.
 */
function centersFormRotation(centers: Uint8Array): boolean {
  if (centers.length !== CENTER_COUNT) return false;

  for (let position = 0; position < OPPOSITE_CENTER_OFFSET; position += 1) {
    const cubie = centers[position]!;
    if (cubie >= CENTER_COUNT) return false;
    const opposite = centers[position + OPPOSITE_CENTER_OFFSET]!;
    if (opposite !== (cubie + OPPOSITE_CENTER_OFFSET) % CENTER_COUNT) return false;
  }

  const up = CENTER_NORMALS[centers[0]!]!;
  const right = CENTER_NORMALS[centers[1]!]!;
  const front = CENTER_NORMALS[centers[2]!]!;
  // right x up lands on front for a proper rotation; a reflection flips it.
  return (
    right[1] * up[2] - right[2] * up[1] === front[0] &&
    right[2] * up[0] - right[0] * up[2] === front[1] &&
    right[0] * up[1] - right[1] * up[0] === front[2]
  );
}

function identityPermutation(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index);
}

/** Returns a fresh solved state. No typed array is shared between calls. */
export function createSolvedState(): CubeState {
  return {
    cp: identityPermutation(CORNER_COUNT),
    co: new Uint8Array(CORNER_COUNT),
    ep: identityPermutation(EDGE_COUNT),
    eo: new Uint8Array(EDGE_COUNT),
    centers: identityPermutation(CENTER_COUNT),
  };
}

/** Returns a deep copy whose four typed arrays are independent of `state`. */
export function cloneState(state: CubeState): CubeState {
  return {
    cp: state.cp.slice(),
    co: state.co.slice(),
    ep: state.ep.slice(),
    eo: state.eo.slice(),
    centers: state.centers.slice(),
  };
}

function arraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Structural equality over all four cubie arrays. */
export function statesEqual(left: CubeState, right: CubeState): boolean {
  return (
    left === right ||
    (arraysEqual(left.cp, right.cp) &&
      arraysEqual(left.co, right.co) &&
      arraysEqual(left.ep, right.ep) &&
      arraysEqual(left.eo, right.eo) &&
      arraysEqual(left.centers, right.centers))
  );
}

/** Explicitly named compatibility alias for callers that compare cube states. */
export const cubeStatesEqual = statesEqual;

/** Exact solved-state check without allocating a reference state. */
export function isSolved(state: CubeState): boolean {
  if (
    state.cp.length !== CORNER_COUNT ||
    state.co.length !== CORNER_COUNT ||
    state.ep.length !== EDGE_COUNT ||
    state.eo.length !== EDGE_COUNT ||
    state.centers.length !== CENTER_COUNT
  ) {
    return false;
  }

  for (let index = 0; index < CORNER_COUNT; index += 1) {
    if (state.cp[index] !== index || state.co[index] !== 0) return false;
  }
  for (let index = 0; index < EDGE_COUNT; index += 1) {
    if (state.ep[index] !== index || state.eo[index] !== 0) return false;
  }
  // Solved means solved in the canonical orientation. A cube left uniform but
  // turned as a whole by slice moves reports false here.
  for (let index = 0; index < CENTER_COUNT; index += 1) {
    if (state.centers[index] !== index) return false;
  }
  return true;
}

function permutationIssue(
  component: PermutationComponent,
  values: Uint8Array,
): Extract<CubeStateValidationIssue, { code: 'INVALID_PERMUTATION' }> | undefined {
  const seen = new Uint8Array(values.length);
  const duplicateValues: number[] = [];

  for (const value of values) {
    if (seen[value] !== 0) {
      if (!duplicateValues.includes(value)) duplicateValues.push(value);
    } else {
      seen[value] = 1;
    }
  }

  if (duplicateValues.length === 0) return undefined;

  const missingValues: number[] = [];
  for (let value = 0; value < seen.length; value += 1) {
    if (seen[value] === 0) missingValues.push(value);
  }

  return {
    code: 'INVALID_PERMUTATION',
    component,
    duplicateValues,
    missingValues,
    message: `${component} must be a permutation; duplicates [${duplicateValues.join(
      ', ',
    )}], missing [${missingValues.join(', ')}]`,
  };
}

function orientationSum(values: Uint8Array): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}

/**
 * Returns 0 for an even permutation and 1 for an odd permutation.
 *
 * A permutation of n elements decomposing into c cycles is a product of n - c
 * transpositions, so counting cycles gives the parity in O(n) rather than
 * inspecting every pair. The visited set is an integer bitmask, which is exact
 * for the 8- and 12-element permutations this module deals in.
 *
 * Callers must have already established that `permutation` is a permutation of
 * 0..n-1; otherwise the cycle walk is not guaranteed to terminate.
 */
function permutationParity(permutation: Uint8Array): 0 | 1 {
  const length = permutation.length;
  let visited = 0;
  let transpositions = 0;

  for (let start = 0; start < length; start += 1) {
    if ((visited & (1 << start)) !== 0) continue;

    let index = start;
    let cycleLength = 0;
    while ((visited & (1 << index)) === 0) {
      visited |= 1 << index;
      index = permutation[index]!;
      cycleLength += 1;
    }
    transpositions += cycleLength - 1;
  }

  return (transpositions & 1) as 0 | 1;
}

const CORNER_PERMUTATION_MASK = (1 << CORNER_COUNT) - 1;
const EDGE_PERMUTATION_MASK = (1 << EDGE_COUNT) - 1;

/**
 * Allocation-free equivalent of `validateState(state).length === 0`.
 *
 * `validateState` exists to produce a full diagnostic report, and building one
 * costs several arrays and objects per call. That report is wasted work on the
 * happy path, which is where every move, every facelet encode and every render
 * sync goes. This checks the same invariants with integer bitmasks and leaves
 * the reporting to `validateState` for the inputs that actually fail.
 */
function isPhysicallyValid(state: unknown): state is CubeState {
  if (typeof state !== 'object' || state === null) return false;
  const { cp, co, ep, eo, centers } = state as Partial<CubeState>;

  if (
    !(cp instanceof Uint8Array) ||
    cp.length !== CORNER_COUNT ||
    !(co instanceof Uint8Array) ||
    co.length !== CORNER_COUNT ||
    !(ep instanceof Uint8Array) ||
    ep.length !== EDGE_COUNT ||
    !(eo instanceof Uint8Array) ||
    eo.length !== EDGE_COUNT ||
    !(centers instanceof Uint8Array) ||
    centers.length !== CENTER_COUNT ||
    !centersFormRotation(centers)
  ) {
    return false;
  }

  let cornerSeen = 0;
  let twist = 0;
  for (let index = 0; index < CORNER_COUNT; index += 1) {
    const cubie = cp[index]!;
    if (cubie >= CORNER_COUNT) return false;
    cornerSeen |= 1 << cubie;

    const orientation = co[index]!;
    if (orientation > 2) return false;
    twist += orientation;
  }
  if (cornerSeen !== CORNER_PERMUTATION_MASK || twist % 3 !== 0) return false;

  let edgeSeen = 0;
  let flip = 0;
  for (let index = 0; index < EDGE_COUNT; index += 1) {
    const cubie = ep[index]!;
    if (cubie >= EDGE_COUNT) return false;
    edgeSeen |= 1 << cubie;

    const orientation = eo[index]!;
    if (orientation > 1) return false;
    flip += orientation;
  }
  if (edgeSeen !== EDGE_PERMUTATION_MASK || (flip & 1) !== 0) return false;

  // A face turn is a 4-cycle on both corners and edges and leaves the centres
  // alone; a slice turn is a 4-cycle on edges and centres and leaves the
  // corners alone. Either way an odd number of the three flips, so the sum of
  // the parities stays even. Before slices existed the centre term was always
  // zero and this read as corner parity equals edge parity.
  return (
    (permutationParity(cp) ^ permutationParity(ep) ^ permutationParity(centers)) === 0
  );
}

/**
 * Reports every independently checkable problem with a candidate state.
 *
 * Invariants whose prerequisites are malformed are skipped, keeping the
 * diagnostics useful (for example, parity is not reported for a duplicate
 * permutation).
 */
export function validateState(state: unknown): readonly CubeStateValidationIssue[] {
  const issues: CubeStateValidationIssue[] = [];

  if (typeof state !== 'object' || state === null) {
    return [
      {
        code: 'INVALID_STATE_TYPE',
        message: 'state must be a non-null object',
      },
    ];
  }

  const candidate = state as Record<string, unknown>;
  const values: Partial<Record<CubeStateComponent, Uint8Array>> = {};
  const structurallyValid: Record<CubeStateComponent, boolean> = {
    cp: false,
    co: false,
    ep: false,
    eo: false,
    centers: false,
  };

  for (const spec of COMPONENT_SPECS) {
    const componentValue = candidate[spec.component];
    if (!(componentValue instanceof Uint8Array)) {
      issues.push({
        code: 'INVALID_COMPONENT_TYPE',
        component: spec.component,
        message: `${spec.component} must be a Uint8Array`,
      });
      continue;
    }

    values[spec.component] = componentValue;
    let valid = true;

    if (componentValue.length !== spec.length) {
      issues.push({
        code: 'INVALID_LENGTH',
        component: spec.component,
        expected: spec.length,
        actual: componentValue.length,
        message: `${spec.component} must have length ${spec.length}, got ${componentValue.length}`,
      });
      valid = false;
    }

    for (let index = 0; index < componentValue.length; index += 1) {
      const value = componentValue[index]!;
      if (value > spec.maximum) {
        issues.push({
          code: 'VALUE_OUT_OF_RANGE',
          component: spec.component,
          index,
          value,
          minimum: 0,
          maximum: spec.maximum,
          message: `${spec.component}[${index}] must be in 0..${spec.maximum}, got ${value}`,
        });
        valid = false;
      }
    }

    structurallyValid[spec.component] = valid;
  }

  if (structurallyValid.cp) {
    const issue = permutationIssue('cp', values.cp!);
    if (issue !== undefined) {
      issues.push(issue);
      structurallyValid.cp = false;
    }
  }

  if (structurallyValid.ep) {
    const issue = permutationIssue('ep', values.ep!);
    if (issue !== undefined) {
      issues.push(issue);
      structurallyValid.ep = false;
    }
  }

  if (structurallyValid.co) {
    const remainder = orientationSum(values.co!) % 3;
    if (remainder !== 0) {
      issues.push({
        code: 'CORNER_ORIENTATION_SUM',
        remainder,
        message: `sum(co) must be divisible by 3, got remainder ${remainder}`,
      });
    }
  }

  if (structurallyValid.eo) {
    const remainder = orientationSum(values.eo!) % 2;
    if (remainder !== 0) {
      issues.push({
        code: 'EDGE_ORIENTATION_SUM',
        remainder,
        message: `sum(eo) must be even, got remainder ${remainder}`,
      });
    }
  }

  if (structurallyValid.centers && !centersFormRotation(values.centers!)) {
    issues.push({
      code: 'INVALID_CENTER_ROTATION',
      message:
        'centers must be one of the 24 whole-cube orientations: opposite ' +
        'positions must hold opposite centers, with the axes right-handed',
    });
  }

  if (structurallyValid.cp && structurallyValid.ep && structurallyValid.centers) {
    const cornerParity = permutationParity(values.cp!);
    const edgeParity = permutationParity(values.ep!);
    const centerParity = permutationParity(values.centers!);
    if ((cornerParity ^ edgeParity ^ centerParity) !== 0) {
      issues.push({
        code: 'PERMUTATION_PARITY_MISMATCH',
        cornerParity,
        edgeParity,
        centerParity,
        message:
          `corner (${cornerParity}), edge (${edgeParity}) and centre ` +
          `(${centerParity}) parities must sum to even`,
      });
    }
  }

  return issues;
}

/** Runtime type guard and physical-validity check. */
export function isValidState(state: unknown): state is CubeState {
  return isPhysicallyValid(state);
}

/** Asserts both the runtime shape and all physical cube invariants. */
export function assertValidState(state: unknown): asserts state is CubeState {
  if (isPhysicallyValid(state)) return;
  throw new CubeStateValidationError(validateState(state));
}
