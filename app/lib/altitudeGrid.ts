import * as THREE from "three";

const EARTH_RADIUS_KM = 6371;
const LABELLED_ALTITUDES = new Set([100, 200, 400, 600, 800, 1000]);

function makeTextSprite(lines: readonly string[]) {
  const fontSize = 38;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create altitude label canvas");
  context.font = `600 ${fontSize}px "Neue Haas Grotesk Text Pro", "Helvetica Neue", Arial, sans-serif`;
  const width = Math.max(...lines.map((line) => context.measureText(line).width));
  const lineHeight = fontSize * 1.18;
  canvas.width = Math.ceil(width + 36);
  canvas.height = Math.ceil(lineHeight * lines.length + 20);
  context.font = `600 ${fontSize}px "Neue Haas Grotesk Text Pro", "Helvetica Neue", Arial, sans-serif`;
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  for (let index = 0; index < lines.length; index += 1) {
    context.fillText(lines[index], 18, 10 + lineHeight * (index + 0.5));
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width * 0.72, canvas.height * 0.72, 1);
  sprite.renderOrder = 1001;
  return sprite;
}

export function slantRangeForAltitude(altitudeKm: number, elevationRad: number) {
  const cosine = Math.cos(elevationRad);
  const sine = Math.sin(elevationRad);
  let low = 0;
  let high = 5000;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const range = (low + high) / 2;
    const horizontal = range * cosine;
    const groundHeight = Math.sqrt(
      Math.max(0, EARTH_RADIUS_KM ** 2 - horizontal ** 2),
    ) - EARTH_RADIUS_KM;
    const altitude = range * sine - groundHeight;
    if (altitude < altitudeKm) low = range;
    else high = range;
  }
  return (low + high) / 2;
}

function addSweepEdgeAxis(
  group: THREE.Group,
  azimuthDeg: number,
  elevationDeg: number,
  outwardSign: number,
) {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const direction = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    -Math.cos(elevation) * Math.cos(azimuth),
  ).normalize();
  const outward = new THREE.Vector3(
    Math.cos(azimuth),
    0,
    Math.sin(azimuth),
  ).multiplyScalar(outwardSign).normalize();
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    depthWrite: false,
  });

  const pointAtAltitude = (altitudeKm: number) => direction.clone().multiplyScalar(
    slantRangeForAltitude(altitudeKm, elevation),
  );
  const axis = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      pointAtAltitude(100),
      pointAtAltitude(1000),
    ]),
    material,
  );
  axis.renderOrder = 1000;
  group.add(axis);

  for (let altitude = 100; altitude <= 1000; altitude += 100) {
    const tickOrigin = pointAtAltitude(altitude);
    const tickLength = altitude % 500 === 0 ? 95 : 60;
    const tick = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        tickOrigin,
        tickOrigin.clone().addScaledVector(outward, tickLength),
      ]),
      material,
    );
    tick.renderOrder = 1000;
    group.add(tick);

    if (LABELLED_ALTITUDES.has(altitude)) {
      const range = slantRangeForAltitude(altitude, elevation);
      const roundedRange = Math.round(range / 10) * 10;
      const label = makeTextSprite([
        `${roundedRange} km RANGE`,
        `${altitude} km ALT`,
      ]);
      label.position.copy(tickOrigin).addScaledVector(outward, 155);
      group.add(label);
    }
  }
}

/** Altitude rulers following the north and south boundaries of the radar sector. */
export function makeAltitudeGrid(
  northAzimuthDeg: number,
  southAzimuthDeg: number,
  elevationDeg: number,
) {
  const group = new THREE.Group();
  group.name = "Sweep-edge altitude axes";
  addSweepEdgeAxis(group, northAzimuthDeg, elevationDeg, 1);
  addSweepEdgeAxis(group, southAzimuthDeg, elevationDeg, -1);
  group.renderOrder = 1000;
  return group;
}
