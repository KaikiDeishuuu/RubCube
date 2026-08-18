import type { CubeState, Face } from '@rubcube/cube-core';
import {
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { CUBIE_DESCRIPTORS, getCubiePoses } from './layout.js';
import type { CubieVisual, GridPosition } from './types.js';

export const DEFAULT_STICKER_COLORS: Readonly<Record<Face, number>> = Object.freeze({
  U: 0xf5f4ed,
  R: 0xd83a32,
  F: 0x20a464,
  D: 0xffd43b,
  L: 0xf08a32,
  B: 0x3478d4,
});

const MATERIAL_FACE_ORDER = ['R', 'L', 'U', 'D', 'F', 'B'] as const;
const FACE_COLOR_UNIFORM_NAMES: Readonly<Record<Face, string>> = Object.freeze({
  R: 'rubCubeFaceColorR',
  L: 'rubCubeFaceColorL',
  U: 'rubCubeFaceColorU',
  D: 'rubCubeFaceColorD',
  F: 'rubCubeFaceColorF',
  B: 'rubCubeFaceColorB',
});
const CUBIE_SHADER_PROGRAM_KEY = 'rubcube-cubie-sticker-inset-v2';
const OBJECT_NORMAL_VARYING = 'vRubCubeObjectNormal';
const OBJECT_POSITION_VARYING = 'vRubCubeObjectPosition';

/** Where the crevice darkening starts, as a fraction of the cubie half-size. */
const OCCLUSION_START = 0.72;
/** Extra reach the darkening gets where two borders meet, softening the corners. */
const OCCLUSION_CORNER_GAIN = 0.45;

const FACE_PALETTE_FRAGMENT_SHADER = /* glsl */ `
  vec3 rubCubeObjectNormal = normalize( ${OBJECT_NORMAL_VARYING} );
  vec3 rubCubeAbsoluteNormal = abs( rubCubeObjectNormal );
  vec3 rubCubeFaceColor;
  vec2 rubCubeFaceCoord;

  if ( rubCubeAbsoluteNormal.x >= rubCubeAbsoluteNormal.y && rubCubeAbsoluteNormal.x >= rubCubeAbsoluteNormal.z ) {
    rubCubeFaceColor = rubCubeObjectNormal.x >= 0.0 ? rubCubeFaceColorR : rubCubeFaceColorL;
    rubCubeFaceCoord = ${OBJECT_POSITION_VARYING}.zy;
  } else if ( rubCubeAbsoluteNormal.y >= rubCubeAbsoluteNormal.z ) {
    rubCubeFaceColor = rubCubeObjectNormal.y >= 0.0 ? rubCubeFaceColorU : rubCubeFaceColorD;
    rubCubeFaceCoord = ${OBJECT_POSITION_VARYING}.xz;
  } else {
    rubCubeFaceColor = rubCubeObjectNormal.z >= 0.0 ? rubCubeFaceColorF : rubCubeFaceColorB;
    rubCubeFaceCoord = ${OBJECT_POSITION_VARYING}.xy;
  }

  // Signed distance to a rounded square, negative inside the sticker. Picking the
  // colour from the normal alone would run it across the bevel and butt two
  // stickers straight against each other; a real cube always shows a plastic
  // border between them, and that border is most of what reads as "not moulded".
  vec2 rubCubeStickerCorner =
    abs( rubCubeFaceCoord ) - rubCubeStickerHalf + rubCubeStickerRadius;
  float rubCubeStickerDistance =
    min( max( rubCubeStickerCorner.x, rubCubeStickerCorner.y ), 0.0 ) +
    length( max( rubCubeStickerCorner, vec2( 0.0 ) ) ) -
    rubCubeStickerRadius;
  float rubCubeStickerFade = max( fwidth( rubCubeStickerDistance ), 1e-5 );
  float rubCubeStickerMask =
    1.0 - smoothstep( -rubCubeStickerFade, rubCubeStickerFade, rubCubeStickerDistance );

  // Faked crevice occlusion. Nothing in the scene casts a shadow, so the gap
  // between neighbouring cubies is lit exactly like the outer faces and the 26
  // pieces read as one block. Darkening towards each cubie's own border puts the
  // shading back where the gap actually is.
  vec2 rubCubeRim = abs( rubCubeFaceCoord ) / rubCubeHalfSize;
  float rubCubeOuterRim = smoothstep( ${OCCLUSION_START.toFixed(2)}, 1.0, max( rubCubeRim.x, rubCubeRim.y ) );
  float rubCubeInnerRim = smoothstep( ${OCCLUSION_START.toFixed(2)}, 1.0, min( rubCubeRim.x, rubCubeRim.y ) );
  float rubCubeOcclusion = 1.0 - rubCubeOcclusionStrength *
    min( rubCubeOuterRim + ${OCCLUSION_CORNER_GAIN.toFixed(2)} * rubCubeInnerRim, 1.0 );

  diffuseColor.rgb =
    mix( rubCubePlasticColor, rubCubeFaceColor, rubCubeStickerMask ) * rubCubeOcclusion;
`;

/**
 * A sticker is a smooth film and the body around it is matte moulded plastic.
 * One roughness for both gives every pixel the same highlight, which is the
 * single most recognisable tell of a CG plastic surface.
 */
const SURFACE_ROUGHNESS_SHADER = /* glsl */ `
  roughnessFactor = mix( rubCubePlasticRoughness, rubCubeStickerRoughness, rubCubeStickerMask );
`;

/**
 * Darkening `diffuseColor` above already covers direct and indirect diffuse.
 * The environment reflection is a separate term, and leaving it at full strength
 * would light the crevices right back up.
 */
const OCCLUSION_SPECULAR_SHADER = /* glsl */ `
  reflectedLight.indirectSpecular *= rubCubeOcclusion;
`;

export interface CubieFactoryOptions {
  readonly cubieSize?: number;
  readonly spacing?: number;
  readonly cornerRadius?: number;
  readonly cornerSegments?: number;
  readonly stickerColors?: Partial<Readonly<Record<Face, number>>>;
  readonly plasticColor?: number;
  /**
   * Sticker width as a fraction of the cubie face. The remainder becomes the
   * plastic border; 1 paints each face edge to edge, as an unstickered mould.
   */
  readonly stickerScale?: number;
  /** Sticker corner rounding as a fraction of its own half-extent. */
  readonly stickerCornerRadius?: number;
  /** Strength of the faked crevice darkening at cubie borders; 0 disables it. */
  readonly edgeOcclusion?: number;
  /** Roughness of the sticker film. Low values give it a tight, glossy highlight. */
  readonly stickerRoughness?: number;
  /** Roughness of the moulded body around and behind the stickers. */
  readonly plasticRoughness?: number;
}

interface CubieSurface {
  readonly colors: Readonly<Record<Face, number>>;
  readonly plasticColor: number;
  readonly halfSize: number;
  readonly stickerHalf: number;
  readonly stickerRadius: number;
  readonly occlusionStrength: number;
  readonly stickerRoughness: number;
  readonly plasticRoughness: number;
}

export interface CubeVisualSet {
  readonly group: Group;
  readonly cubies: readonly CubieVisual[];
  readonly geometry: BufferGeometry;
  readonly materials: readonly MeshStandardMaterial[];
  readonly cubieSize: number;
  readonly spacing: number;
  sync(state: CubeState): void;
  dispose(): void;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function unitFraction(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

function createCubieMaterial(
  stickerFaces: readonly Face[],
  surface: CubieSurface,
): MeshStandardMaterial {
  const stickers = new Set(stickerFaces);
  const facePalette = Object.fromEntries(
    MATERIAL_FACE_ORDER.map((face) => [
      face,
      new Color(stickers.has(face) ? surface.colors[face] : surface.plasticColor),
    ]),
  ) as Record<Face, Color>;
  const plastic = new Color(surface.plasticColor);
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    metalness: 0.02,
    // The shader overwrites roughnessFactor per fragment; this is the value the
    // cube falls back to if that injection ever stops matching.
    roughness: surface.plasticRoughness,
  });

  material.userData.facePalette = facePalette;
  material.onBeforeCompile = (shader) => {
    for (const face of MATERIAL_FACE_ORDER) {
      shader.uniforms[FACE_COLOR_UNIFORM_NAMES[face]] = {
        value: facePalette[face],
      };
    }
    shader.uniforms.rubCubePlasticColor = { value: plastic };
    shader.uniforms.rubCubeHalfSize = { value: surface.halfSize };
    shader.uniforms.rubCubeStickerHalf = { value: surface.stickerHalf };
    shader.uniforms.rubCubeStickerRadius = { value: surface.stickerRadius };
    shader.uniforms.rubCubeOcclusionStrength = { value: surface.occlusionStrength };
    shader.uniforms.rubCubeStickerRoughness = { value: surface.stickerRoughness };
    shader.uniforms.rubCubePlasticRoughness = { value: surface.plasticRoughness };

    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `varying vec3 ${OBJECT_NORMAL_VARYING};\nvarying vec3 ${OBJECT_POSITION_VARYING};\n\nvoid main() {`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n\t${OBJECT_NORMAL_VARYING} = normalize( objectNormal );` +
          `\n\t${OBJECT_POSITION_VARYING} = position;`,
      );

    const faceUniformDeclarations = MATERIAL_FACE_ORDER.map(
      (face) => `uniform vec3 ${FACE_COLOR_UNIFORM_NAMES[face]};`,
    ).join('\n');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `varying vec3 ${OBJECT_NORMAL_VARYING};\nvarying vec3 ${OBJECT_POSITION_VARYING};\n` +
          `${faceUniformDeclarations}\nuniform vec3 rubCubePlasticColor;\n` +
          'uniform float rubCubeHalfSize;\nuniform float rubCubeStickerHalf;\n' +
          'uniform float rubCubeStickerRadius;\nuniform float rubCubeOcclusionStrength;\n' +
          'uniform float rubCubeStickerRoughness;\nuniform float rubCubePlasticRoughness;\n\nvoid main() {',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n${FACE_PALETTE_FRAGMENT_SHADER}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${SURFACE_ROUGHNESS_SHADER}`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>\n${OCCLUSION_SPECULAR_SHADER}`,
      );
  };
  material.customProgramCacheKey = () => CUBIE_SHADER_PROGRAM_KEY;
  return material;
}

/** Create the 26 identity-stable cubie meshes and synchronize their first pose. */
export function createCubeVisuals(
  state: CubeState,
  options: CubieFactoryOptions = {},
): CubeVisualSet {
  // Validate and resolve the initial state before allocating disposable GPU resources.
  const initialPoses = getCubiePoses(state);
  const cubieSize = positiveFinite(options.cubieSize ?? 0.94, 'cubieSize');
  const spacing = positiveFinite(options.spacing ?? 1, 'spacing');
  const cornerRadius = positiveFinite(
    options.cornerRadius ?? cubieSize * 0.06,
    'cornerRadius',
  );
  const cornerSegments = options.cornerSegments ?? 3;
  if (!Number.isSafeInteger(cornerSegments) || cornerSegments < 1) {
    throw new RangeError('cornerSegments must be a positive safe integer');
  }

  const colors = {
    ...DEFAULT_STICKER_COLORS,
    ...options.stickerColors,
  } satisfies Record<Face, number>;
  const plasticColor = options.plasticColor ?? 0x171817;
  const halfSize = cubieSize / 2;
  const stickerHalf = halfSize * unitFraction(options.stickerScale ?? 0.82, 'stickerScale');
  const surface: CubieSurface = {
    colors,
    plasticColor,
    halfSize,
    stickerHalf,
    stickerRadius:
      stickerHalf * unitFraction(options.stickerCornerRadius ?? 0.18, 'stickerCornerRadius'),
    occlusionStrength: unitFraction(options.edgeOcclusion ?? 0.5, 'edgeOcclusion'),
    stickerRoughness: unitFraction(options.stickerRoughness ?? 0.26, 'stickerRoughness'),
    plasticRoughness: unitFraction(options.plasticRoughness ?? 0.68, 'plasticRoughness'),
  };
  const geometry = new RoundedBoxGeometry(
    cubieSize,
    cubieSize,
    cubieSize,
    cornerSegments,
    cornerRadius,
  );
  geometry.computeBoundingSphere();

  const group = new Group();
  group.name = 'RubCube';
  const materials: MeshStandardMaterial[] = [];
  const cubies: CubieVisual[] = CUBIE_DESCRIPTORS.map((descriptor) => {
    const material = createCubieMaterial(descriptor.stickerFaces, surface);
    materials.push(material);
    const mesh = new Mesh(geometry, material);
    mesh.name = descriptor.id;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const visual: CubieVisual = {
      descriptor,
      object: mesh,
      gridPosition: descriptor.homePosition,
    };
    mesh.userData.cubieVisual = visual;
    group.add(mesh);
    return visual;
  });

  let disposed = false;
  const visualById = new Map(cubies.map((visual) => [visual.descriptor.id, visual]));

  const applyPoses = (poses: ReturnType<typeof getCubiePoses>): void => {
    for (const pose of poses) {
      const visual = visualById.get(pose.descriptor.id);
      if (visual === undefined) {
        throw new Error(`Missing visual for ${pose.descriptor.id}`);
      }
      visual.gridPosition = pose.gridPosition;
      visual.object.position.set(
        pose.gridPosition[0] * spacing,
        pose.gridPosition[1] * spacing,
        pose.gridPosition[2] * spacing,
      );
      visual.object.quaternion.copy(pose.quaternion);
      visual.object.scale.set(1, 1, 1);
      visual.object.updateMatrix();
    }
    group.updateMatrixWorld(true);
  };
  const sync = (nextState: CubeState): void => {
    applyPoses(getCubiePoses(nextState));
  };

  applyPoses(initialPoses);

  return {
    group,
    cubies,
    geometry,
    materials,
    cubieSize,
    spacing,
    sync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
}
