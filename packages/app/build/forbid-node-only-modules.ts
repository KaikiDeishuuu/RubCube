import type { Plugin } from 'vite';

/**
 * Fails the production build if a Node-only module reaches a browser chunk
 * (DESIGN-SOLVING.md 2.7).
 *
 * The optimal solver is kept out of the browser by policy, not by dependency:
 * it imports nothing platform-specific, so nothing stops an import of it from
 * type-checking, passing tests and quietly adding tens of megabytes of ball to
 * the bundle. A subpath export says where it belongs; this says so in a way
 * that fails.
 *
 * The check reads Rollup's module graph rather than searching the emitted text.
 * A text search would answer a different question — whether some identifying
 * string survived minification — and would go quiet the first time a name got
 * mangled. `moduleIds` is the transitive closure Rollup actually pulled in, so
 * a dynamic import counts exactly like a static one.
 */

export interface ForbiddenModule {
  readonly reason: string;
  readonly pattern: RegExp;
}

export const NODE_ONLY_MODULES: readonly ForbiddenModule[] = Object.freeze([
  Object.freeze({
    reason:
      'the optimal solver is bench-only: its ball is 621,649 states and it is ' +
      'published on @rubcube/cube-core/optimal for Node',
    // Matches the source tree and the built one, on either path separator.
    pattern: /[\\/]cube-core[\\/](?:src|dist)[\\/]optimal[\\/]/,
  }),
]);

export interface Offender {
  readonly chunk: string;
  readonly moduleId: string;
  readonly reason: string;
}

/** The pure half, so the rule can be tested without running a build. */
export function findForbiddenModules(
  chunks: Iterable<{ readonly fileName: string; readonly moduleIds: readonly string[] }>,
  forbidden: readonly ForbiddenModule[] = NODE_ONLY_MODULES,
): Offender[] {
  const offenders: Offender[] = [];
  for (const chunk of chunks) {
    for (const moduleId of chunk.moduleIds) {
      for (const rule of forbidden) {
        if (rule.pattern.test(moduleId)) {
          offenders.push({ chunk: chunk.fileName, moduleId, reason: rule.reason });
        }
      }
    }
  }
  return offenders;
}

export function describeOffenders(offenders: readonly Offender[]): string {
  const lines = offenders.map(
    (offender) => `  ${offender.chunk} pulls in ${offender.moduleId}\n    (${offender.reason})`,
  );
  return `Node-only modules reached the browser bundle:\n${lines.join('\n')}`;
}

export function forbidNodeOnlyModules(
  forbidden: readonly ForbiddenModule[] = NODE_ONLY_MODULES,
): Plugin {
  return {
    name: 'rubcube:forbid-node-only-modules',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(
        (output): output is Extract<typeof output, { type: 'chunk' }> =>
          output.type === 'chunk',
      );
      const offenders = findForbiddenModules(chunks, forbidden);
      if (offenders.length > 0) this.error(describeOffenders(offenders));
    },
  };
}
