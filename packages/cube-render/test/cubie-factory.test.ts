import {
  CubeStateValidationError,
  createSolvedState,
} from '@rubcube/cube-core';
import { Color, Mesh, ShaderLib, type MeshStandardMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STICKER_COLORS,
  createCubeVisuals,
} from '../src/cubie-factory.js';

describe('cubie mesh factory', () => {
  it('creates 26 single-material meshes sharing one rounded geometry', () => {
    const visuals = createCubeVisuals(createSolvedState());
    const meshes = visuals.cubies.map((cubie) => {
      expect(cubie.object).toBeInstanceOf(Mesh);
      return cubie.object as Mesh;
    });

    expect(visuals.cubies).toHaveLength(26);
    expect(visuals.group.children).toHaveLength(26);
    expect(new Set(visuals.cubies.map((cubie) => cubie.object.name)).size).toBe(26);
    expect(new Set(meshes.map((mesh) => mesh.geometry))).toEqual(
      new Set([visuals.geometry]),
    );
    expect(meshes.every((mesh) => !Array.isArray(mesh.material))).toBe(true);
    expect(visuals.materials).toHaveLength(26);
    expect(new Set(visuals.materials).size).toBe(26);
    expect(
      meshes.every((mesh, index) => mesh.material === visuals.materials[index]),
    ).toBe(true);
    expect(
      new Set(visuals.materials.map((material) => material.customProgramCacheKey())),
    ).toEqual(new Set(['rubcube-cubie-sticker-inset-v2']));
    expect(visuals.cubieSize).toBe(0.94);
    expect(DEFAULT_STICKER_COLORS.U).toBe(0xf5f4ed);
  });

  it('injects a local rounded-normal shader with a six-face cubie palette', () => {
    const plasticColor = 0x010203;
    const visuals = createCubeVisuals(createSolvedState(), {
      stickerColors: { U: 0xabcdef },
      plasticColor,
    });
    const cornerIndex = visuals.cubies.findIndex(
      (cubie) => cubie.descriptor.id === 'corner:URF',
    );
    const material = visuals.materials[cornerIndex]!;
    const shader = {
      uniforms: {},
      vertexShader: 'void main() {\n#include <beginnormal_vertex>\n}',
      fragmentShader:
        'void main() {\n#include <color_fragment>\n#include <roughnessmap_fragment>\n' +
        '#include <aomap_fragment>\n}',
    } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];

    material.onBeforeCompile(shader, null as never);

    expect(shader.vertexShader).toContain('varying vec3 vRubCubeObjectNormal;');
    expect(shader.vertexShader).toContain(
      'vRubCubeObjectNormal = normalize( objectNormal );',
    );
    expect(shader.vertexShader).toContain('vRubCubeObjectPosition = position;');
    expect(shader.fragmentShader).toContain('rubCubeAbsoluteNormal.x');
    expect(shader.fragmentShader).toContain(
      'rubCubeObjectNormal.z >= 0.0 ? rubCubeFaceColorF : rubCubeFaceColorB',
    );
    // The sticker border and the crevice darkening both need the local surface
    // coordinate; selecting by normal alone can produce neither.
    expect(shader.fragmentShader).toContain('rubCubeStickerDistance');
    expect(shader.fragmentShader).toContain(
      'mix( rubCubePlasticColor, rubCubeFaceColor, rubCubeStickerMask ) * rubCubeOcclusion',
    );
    expect(shader.fragmentShader).toContain('reflectedLight.indirectSpecular *= rubCubeOcclusion;');
    // The sticker film and the moulded body must not share one highlight.
    expect(shader.fragmentShader).toContain(
      'roughnessFactor = mix( rubCubePlasticRoughness, rubCubeStickerRoughness, rubCubeStickerMask );',
    );

    const expectedPalette = {
      R: DEFAULT_STICKER_COLORS.R,
      L: plasticColor,
      U: 0xabcdef,
      D: plasticColor,
      F: DEFAULT_STICKER_COLORS.F,
      B: plasticColor,
    } as const;
    for (const [face, color] of Object.entries(expectedPalette)) {
      const uniform = shader.uniforms[`rubCubeFaceColor${face}`];
      expect(uniform).toBeDefined();
      expect(uniform!.value).toBeInstanceOf(Color);
      expect((uniform!.value as Color).getHex()).toBe(color);
    }
  });

  it('injects into chunk names three still ships', () => {
    // onBeforeCompile is string surgery. If a three upgrade renames one of these
    // chunks, String.replace silently no-ops and the cube quietly renders with
    // stock shading instead of failing, so pin the anchors.
    expect(ShaderLib.standard.vertexShader).toContain('#include <beginnormal_vertex>');
    expect(ShaderLib.standard.vertexShader).toContain('void main() {');
    expect(ShaderLib.standard.fragmentShader).toContain('#include <color_fragment>');
    expect(ShaderLib.standard.fragmentShader).toContain('#include <roughnessmap_fragment>');
    expect(ShaderLib.standard.fragmentShader).toContain('#include <aomap_fragment>');
    // The sticker mask is declared at <color_fragment> and read by the two
    // later injections, so their order is part of the contract.
    const fragment = ShaderLib.standard.fragmentShader;
    expect(fragment.indexOf('#include <color_fragment>')).toBeLessThan(
      fragment.indexOf('#include <roughnessmap_fragment>'),
    );
    expect(fragment.indexOf('#include <roughnessmap_fragment>')).toBeLessThan(
      fragment.indexOf('#include <aomap_fragment>'),
    );
  });

  it('derives sticker and occlusion uniforms from the cubie size', () => {
    const visuals = createCubeVisuals(createSolvedState(), {
      cubieSize: 1,
      stickerScale: 0.8,
      stickerCornerRadius: 0.25,
      edgeOcclusion: 0.4,
      stickerRoughness: 0.2,
      plasticRoughness: 0.7,
    });
    const shader = {
      uniforms: {},
      vertexShader: 'void main() {\n#include <beginnormal_vertex>\n}',
      fragmentShader: 'void main() {\n#include <color_fragment>\n}',
    } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];

    visuals.materials[0]!.onBeforeCompile(shader, null as never);

    expect(shader.uniforms.rubCubeHalfSize!.value).toBeCloseTo(0.5, 12);
    expect(shader.uniforms.rubCubeStickerHalf!.value).toBeCloseTo(0.4, 12);
    expect(shader.uniforms.rubCubeStickerRadius!.value).toBeCloseTo(0.1, 12);
    expect(shader.uniforms.rubCubeOcclusionStrength!.value).toBe(0.4);
    expect(shader.uniforms.rubCubeStickerRoughness!.value).toBe(0.2);
    expect(shader.uniforms.rubCubePlasticRoughness!.value).toBe(0.7);
    expect((shader.uniforms.rubCubePlasticColor!.value as Color).getHex()).toBe(0x171817);
    // A failed shader injection must degrade to matte plastic, not glossy.
    expect(visuals.materials[0]!.roughness).toBe(0.7);
  });

  it('rejects surface fractions outside 0..1', () => {
    for (const options of [
      { stickerScale: 1.2 },
      { stickerScale: -0.1 },
      { stickerCornerRadius: 2 },
      { edgeOcclusion: Number.NaN },
      { stickerRoughness: 1.5 },
      { plasticRoughness: -1 },
    ]) {
      expect(() => createCubeVisuals(createSolvedState(), options)).toThrow(RangeError);
    }
  });

  it('places solved cubies on the integer lattice with the requested spacing', () => {
    const visuals = createCubeVisuals(createSolvedState(), { spacing: 1.25 });
    const positions = visuals.cubies.map((cubie) => cubie.object.position.toArray().join(','));

    expect(new Set(positions).size).toBe(26);
    expect(positions).not.toContain('0,0,0');
    for (const coordinate of visuals.cubies.flatMap((cubie) => cubie.object.position.toArray())) {
      expect([-1.25, 0, 1.25]).toContain(coordinate);
    }
  });

  it('supports palette overrides and validates geometry options', () => {
    const visuals = createCubeVisuals(createSolvedState(), {
      stickerColors: { U: 0xabcdef },
      cubieSize: 0.88,
    });
    expect(visuals.cubieSize).toBe(0.88);

    expect(() => createCubeVisuals(createSolvedState(), { cubieSize: 0 })).toThrow(RangeError);
    expect(() => createCubeVisuals(createSolvedState(), { spacing: Infinity })).toThrow(RangeError);
    expect(() => createCubeVisuals(createSolvedState(), { cornerSegments: 0 })).toThrow(RangeError);
  });

  it('validates the initial state before allocating visual resources', () => {
    const invalidState = createSolvedState();
    invalidState.co[0] = 1;

    expect(() =>
      createCubeVisuals(invalidState, { cubieSize: 0 }),
    ).toThrow(CubeStateValidationError);
  });

  it('disposes shared resources once', () => {
    const visuals = createCubeVisuals(createSolvedState());
    const geometryDispose = vi.spyOn(visuals.geometry, 'dispose');
    const materialDisposes = visuals.materials.map((material) =>
      vi.spyOn(material, 'dispose'),
    );

    visuals.dispose();
    visuals.dispose();

    expect(geometryDispose).toHaveBeenCalledOnce();
    for (const dispose of materialDisposes) expect(dispose).toHaveBeenCalledOnce();
    expect(visuals.group.children).toHaveLength(0);
  });
});
