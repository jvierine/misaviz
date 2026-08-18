import * as THREE from "three";

import { slantRangeForAltitude } from "./altitudeGrid";
import { misaBoresight } from "./misaAntenna";

/**
 * Full-width at half maximum reported for the 440 MHz, 46 m MISA beam.
 * Longley et al. (2020), JGR Space Physics, doi:10.1029/2019JA027708.
 */
export const MISA_BEAM_FWHM_DEG = 1.2;

const FOOTPRINT_ALTITUDES_KM = [100, 200, 400, 600, 800, 1000] as const;

export type BeamFootprints = {
  group: THREE.Group;
  boxes: THREE.LineSegments[];
};

export function beamDiameterAtRangeKm(rangeKm: number) {
  return 2 * rangeKm * Math.tan(THREE.MathUtils.degToRad(MISA_BEAM_FWHM_DEG / 2));
}

export function makeBeamFootprints(): BeamFootprints {
  const group = new THREE.Group();
  group.name = "MISA 1.2 degree FWHM beam footprints";
  const material = new THREE.LineBasicMaterial({
    color: 0xb8e8ff,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
  });
  const unitBoxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const boxes = FOOTPRINT_ALTITUDES_KM.map(() => {
    const box = new THREE.LineSegments(unitBoxEdges, material);
    box.renderOrder = 22;
    group.add(box);
    return box;
  });
  return { group, boxes };
}

/** Keep each box centered on and perpendicular to the instantaneous boresight. */
export function updateBeamFootprints(
  footprints: BeamFootprints,
  azimuthDeg: number,
  elevationDeg: number,
) {
  const direction = misaBoresight(azimuthDeg, elevationDeg).normalize();
  const orientation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    direction,
  );
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  for (let index = 0; index < FOOTPRINT_ALTITUDES_KM.length; index += 1) {
    const range = slantRangeForAltitude(FOOTPRINT_ALTITUDES_KM[index], elevation);
    const width = beamDiameterAtRangeKm(range);
    const box = footprints.boxes[index];
    box.position.copy(direction).multiplyScalar(range);
    box.quaternion.copy(orientation);
    box.scale.set(width, width, Math.max(8, width * 0.25));
  }
}
