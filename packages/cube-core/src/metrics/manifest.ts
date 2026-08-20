import { serializeMoves } from '../moves.js';
import {
  HTM_V1_MOVE_ORDER,
  NODE_COUNTING_VERSION,
  SOLVER_FINGERPRINT,
  TABLE_FINGERPRINT,
} from '../solver/constants.js';
import { BENCH_SOLVER_NODE_BUDGET, TWO_PHASE_MAX_LENGTH } from '../solver/search.js';

/**
 * The pre-registered M3d distance-proxy validation profile.
 *
 * DESIGN.md section 9 asks for exactly one manifest: it fixes the corpora, the
 * seed, the whole solver profile, both fingerprints, the minimum coverage and
 * the go/no-go thresholds *before* the experiment runs, so a proxy cannot be
 * declared good by moving the bar it was measured against. Everything below is
 * therefore data, not tuning knobs, and the numbers a run reports are compared
 * to it rather than folded back into it.
 *
 * A pilot of about sixty samples per statistic ran before these numbers were
 * written down, to check the corpora were affordable and the statistics were
 * the informative ones. The thresholds themselves come from what
 * `progress_score` needs to be usable, spelled out per line below; the corpora
 * that decide the verdict use a different seed from that pilot.
 */

/**
 * The one solver profile the judge may score with.
 *
 * Identical to the M3b acceptance profile on purpose: a proxy validated under
 * one search configuration says nothing about another, and keeping a single
 * profile across the repository means the fingerprints already committed cover
 * this one too. `budgetMs` is absent and must stay absent — a wall-clock fuse
 * would let the same state score differently on a loaded machine.
 */
export const DISTANCE_PROXY_PROFILE = Object.freeze({
  hardMax: 30,
  targetLength: 21,
  maxNodes: BENCH_SOLVER_NODE_BUDGET,
});

/**
 * Corpus classes, sizes and seed.
 *
 * The three classes answer three different questions, which is why one corpus
 * cannot replace them:
 *
 * - `knownDistance` is the only class with ground truth, because the k<=9
 *   bidirectional solver (M3c) is the only thing that can produce it. It gives
 *   correlation and absolute error, and it is also the *hardest* domain for a
 *   two-phase search, whose whole design assumes a cube far from solved.
 * - `trajectory` is where `progress_score` is actually read. Until M4 exists
 *   there are no model traces, so this class is a declared surrogate; see
 *   `TRAJECTORY_SURROGATE`.
 * - `adjacent` needs no oracle at all: one move changes the true distance by
 *   exactly one, at any distance. It is the only evidence available in the
 *   10-to-21 band where the benchmark actually operates, and that is precisely
 *   the band no oracle can reach.
 */
export const M3D_CORPUS = Object.freeze({
  seed: 0x4d_33_44_00,
  knownDistance: Object.freeze({ minLength: 1, maxLength: 9, perLength: 100 }),
  trajectory: Object.freeze({ tasks: 40, maxSteps: 30, slipRate: 0.25 }),
  adjacent: Object.freeze({
    /** Uniform random is `null`; the numbers are scramble lengths. */
    bases: Object.freeze([null, 6, 10, 14] as const),
    basesPerClass: 50,
    movesPerBase: 3,
  }),
  control: Object.freeze({ walks: 20, steps: 20 }),
});

/**
 * How the trajectory class is built, and why it is not a model trace.
 *
 * A benchmark trajectory is a partly-competent descent: mostly moves that help,
 * with slips that do not. The surrogate reproduces that shape by walking the
 * first move of a real solver solution and, at `slipRate`, taking a uniformly
 * random move instead. It is not a model, and no claim here transfers to one
 * without re-running this profile on real traces once M4 lands.
 */
export const TRAJECTORY_SURROGATE = 'solver-guided-walk-with-slips-v1';

/**
 * Go/no-go thresholds, each derived from what the score needs.
 *
 * `progress_score = 1 - proxyLen(s_final) / proxyLen(s_0)` on a baseline of
 * about 21 moves, so one move of proxy error is about 0.05 of score:
 *
 * - `minCoverage`: a null proxy is a dropped sample, and DESIGN.md section 6.5
 *   forbids filling those in. One percent is the most a headline metric can
 *   lose and still be reported without a caveat.
 * - `minSpearman`: ordering states by remaining work is the score's entire job.
 * - `maxMeanAbsoluteError`: 1.5 moves keeps the typical score error near 0.07.
 * - `maxInversionRate`: one pair in twenty ranked backwards is tolerable in an
 *   aggregate; one in ten would mean the ordering is not real.
 * - `minDirectionAgreement`: one genuinely correct move should register as
 *   progress at least nine times out of ten.
 * - `maxLipschitzViolationRate`: this is a shape check, not a precision one -
 *   precision is already gated by the error and inversion lines - so it allows
 *   twice the slack. A distance function moves by one per move; a proxy that
 *   jumped by more than one on a fifth of all moves would not be distance-like.
 */
export const M3D_THRESHOLDS = Object.freeze({
  minCoverage: 0.99,
  minSpearman: 0.9,
  maxMeanAbsoluteError: 1.5,
  maxInversionRate: 0.05,
  minDirectionAgreement: 0.9,
  maxLipschitzViolationRate: 0.1,
});

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

/** Canonical text hashed into M3D_FINGERPRINT. Keep byte-for-byte stable. */
export const M3D_MANIFEST = [
  'rubcube-distance-proxy-m3d-v1',
  'proxy=two-phase-solution-length',
  `solver-profile=hardMax:${DISTANCE_PROXY_PROFILE.hardMax},targetLength:${DISTANCE_PROXY_PROFILE.targetLength},maxNodes:${DISTANCE_PROXY_PROFILE.maxNodes},budgetMs:none`,
  `hard-max-ceiling=${TWO_PHASE_MAX_LENGTH}`,
  `move-order=htm-v1:${serializeMoves(HTM_V1_MOVE_ORDER).split(' ').join(',')}`,
  'canonical=same-face-forbidden;opposites=UD,RL,FB;phase-boundary-reset',
  `node-counting=${NODE_COUNTING_VERSION}`,
  `solver-fingerprint=${SOLVER_FINGERPRINT}`,
  `table-fingerprint=${TABLE_FINGERPRINT}`,
  `corpus-seed=${hex(M3D_CORPUS.seed)}`,
  `corpus-a=known-distance:lengths${M3D_CORPUS.knownDistance.minLength}-${M3D_CORPUS.knownDistance.maxLength},perLength${M3D_CORPUS.knownDistance.perLength},reference=bidirectional-optimal`,
  `corpus-b=trajectory:tasks${M3D_CORPUS.trajectory.tasks},maxSteps${M3D_CORPUS.trajectory.maxSteps},slipRate${M3D_CORPUS.trajectory.slipRate},surrogate=${TRAJECTORY_SURROGATE}`,
  `corpus-c=adjacent-pairs:bases=${M3D_CORPUS.adjacent.bases.map((base) => base ?? 'uniform').join('/')},perClass${M3D_CORPUS.adjacent.basesPerClass},movesPerBase${M3D_CORPUS.adjacent.movesPerBase}`,
  `control=undirected-random-walk:walks${M3D_CORPUS.control.walks},steps${M3D_CORPUS.control.steps},from=solved`,
  `gate-coverage>=${M3D_THRESHOLDS.minCoverage}`,
  `gate-spearman>=${M3D_THRESHOLDS.minSpearman}`,
  `gate-mae<=${M3D_THRESHOLDS.maxMeanAbsoluteError}`,
  `gate-inversion<=${M3D_THRESHOLDS.maxInversionRate}`,
  `gate-direction>=${M3D_THRESHOLDS.minDirectionAgreement}`,
  `gate-lipschitz<=${M3D_THRESHOLDS.maxLipschitzViolationRate}`,
].join('\n');

/** SHA-256 of M3D_MANIFEST. */
export const M3D_FINGERPRINT =
  'sha256:0781cb57abf9e6189c4505acb63d1e099c8cd087373ecda12c513fab59061ad8';
