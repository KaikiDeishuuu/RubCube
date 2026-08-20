import { describe, expect, it } from 'vitest';

import {
  NODE_ONLY_MODULES,
  describeOffenders,
  findForbiddenModules,
  forbidNodeOnlyModules,
} from './forbid-node-only-modules.js';

const CHUNK = (fileName: string, moduleIds: string[]) => ({ fileName, moduleIds });

describe('node-only module guard', () => {
  it('passes a bundle that only reaches the browser-safe subpaths', () => {
    const offenders = findForbiddenModules([
      CHUNK('assets/index-abc.js', [
        '/repo/packages/app/src/App.tsx',
        '/repo/packages/cube-core/dist/solver/search.js',
        '/repo/packages/cube-core/dist/state.js',
      ]),
      CHUNK('assets/worker-def.js', ['/repo/packages/app/src/solver/worker.ts']),
    ]);
    expect(offenders).toEqual([]);
  });

  it.each([
    ['built', '/repo/packages/cube-core/dist/optimal/bidirectional.js'],
    ['source', '/repo/packages/cube-core/src/optimal/index.ts'],
    ['windows', 'C:\\repo\\packages\\cube-core\\dist\\optimal\\index.js'],
  ])('catches the %s optimal solver', (_label, moduleId) => {
    const offenders = findForbiddenModules([CHUNK('assets/index-abc.js', [moduleId])]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.moduleId).toBe(moduleId);
    expect(describeOffenders(offenders)).toContain('assets/index-abc.js');
  });

  it('does not fire on a path that merely contains the word', () => {
    // The rule is about a package subpath, not about the string "optimal"
    // appearing somewhere in a file name.
    const offenders = findForbiddenModules([
      CHUNK('assets/index-abc.js', ['/repo/packages/app/src/optimal-layout.ts']),
    ]);
    expect(offenders).toEqual([]);
  });

  it('names every chunk that pulls one in', () => {
    const moduleId = '/repo/packages/cube-core/dist/optimal/bidirectional.js';
    const offenders = findForbiddenModules([
      CHUNK('assets/index-abc.js', [moduleId]),
      CHUNK('assets/worker-def.js', [moduleId]),
    ]);
    expect(offenders.map((offender) => offender.chunk)).toEqual([
      'assets/index-abc.js',
      'assets/worker-def.js',
    ]);
  });

  it('fails the build through the plugin hook', () => {
    const plugin = forbidNodeOnlyModules();
    const generateBundle = plugin.generateBundle;
    expect(typeof generateBundle).toBe('function');

    const errors: string[] = [];
    const context = {
      error(message: string) {
        errors.push(message);
        throw new Error(message);
      },
    };
    const bundle = {
      'assets/index-abc.js': {
        type: 'chunk',
        fileName: 'assets/index-abc.js',
        moduleIds: ['/repo/packages/cube-core/dist/optimal/bidirectional.js'],
      },
      'assets/style.css': { type: 'asset', fileName: 'assets/style.css' },
    };

    const hook = generateBundle as unknown as (
      this: typeof context,
      options: unknown,
      bundle: unknown,
    ) => void;
    expect(() => hook.call(context, {}, bundle)).toThrow(/Node-only modules/);
    expect(errors[0]).toContain('bench-only');
  });

  it('only runs on production builds', () => {
    expect(forbidNodeOnlyModules().apply).toBe('build');
    expect(NODE_ONLY_MODULES).toHaveLength(1);
  });
});
