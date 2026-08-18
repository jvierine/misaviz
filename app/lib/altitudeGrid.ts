import * as THREE from "three";

const EARTH_RADIUS_KM = 6371;

type GeographicAnchor = {
  name: string;
  latitude: number;
  longitude: number;
};

const ALTITUDE_ANCHORS: readonly GeographicAnchor[] = [
  { name: "FLORIDA", latitude: 28.1, longitude: -81.6 },
  { name: "HEARST", latitude: 49.6866, longitude: -83.6545 },
];

function ecefDirection(latitudeDeg: number, longitudeDeg: number) {
  const latitude = THREE.MathUtils.degToRad(latitudeDeg);
  const longitude = THREE.MathUtils.degToRad(longitudeDeg);
  return new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
}

function makeTextSprite(text: string, fontSize = 25) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create altitude label canvas");
  context.font = `600 ${fontSize}px "Neue Haas Grotesk Text Pro", "Helvetica Neue", Arial, sans-serif`;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width + 28);
  canvas.height = Math.ceil(fontSize * 1.55);
  context.font = `600 ${fontSize}px "Neue Haas Grotesk Text Pro", "Helvetica Neue", Arial, sans-serif`;
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, 14, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width * 0.55, canvas.height * 0.55, 1);
  sprite.renderOrder = 1001;
  return sprite;
}

function localBasis(stationLat: number, stationLon: number) {
  const latitude = THREE.MathUtils.degToRad(stationLat);
  const longitude = THREE.MathUtils.degToRad(stationLon);
  return {
    up: ecefDirection(stationLat, stationLon),
    east: new THREE.Vector3(-Math.sin(longitude), Math.cos(longitude), 0),
    north: new THREE.Vector3(
      -Math.sin(latitude) * Math.cos(longitude),
      -Math.sin(latitude) * Math.sin(longitude),
      Math.cos(latitude),
    ),
  };
}

function ecefVectorToScene(vector: THREE.Vector3, basis: ReturnType<typeof localBasis>) {
  return new THREE.Vector3(
    vector.dot(basis.east),
    vector.dot(basis.up),
    -vector.dot(basis.north),
  );
}

function addAltitudeAxis(
  group: THREE.Group,
  anchor: GeographicAnchor,
  basis: ReturnType<typeof localBasis>,
) {
  const radialEcef = ecefDirection(anchor.latitude, anchor.longitude);
  const groundEcef = radialEcef.clone().sub(basis.up).multiplyScalar(EARTH_RADIUS_KM);
  const ground = ecefVectorToScene(groundEcef, basis);
  const radial = ecefVectorToScene(radialEcef, basis).normalize();
  const longitude = THREE.MathUtils.degToRad(anchor.longitude);
  const eastEcef = new THREE.Vector3(-Math.sin(longitude), Math.cos(longitude), 0);
  const tickDirection = ecefVectorToScene(eastEcef, basis).normalize();
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.86,
    depthTest: false,
    depthWrite: false,
  });

  const mainLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      ground.clone().addScaledVector(radial, 100),
      ground.clone().addScaledVector(radial, 1000),
    ]),
    material,
  );
  mainLine.renderOrder = 1000;
  group.add(mainLine);

  for (let altitude = 100; altitude <= 1000; altitude += 100) {
    const tickLength = altitude % 500 === 0 ? 90 : 55;
    const tickOrigin = ground.clone().addScaledVector(radial, altitude);
    const tickLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        tickOrigin,
        tickOrigin.clone().addScaledVector(tickDirection, tickLength),
      ]),
      material,
    );
    tickLine.renderOrder = 1000;
    group.add(tickLine);

    if (altitude === 100 || altitude === 1000 || altitude % 200 === 0) {
      const label = makeTextSprite(`${altitude} km`);
      label.position.copy(tickOrigin).addScaledVector(tickDirection, 120);
      group.add(label);
    }
  }

  const placeLabel = makeTextSprite(anchor.name, 22);
  placeLabel.position.copy(ground).addScaledVector(radial, 55).addScaledVector(tickDirection, 75);
  group.add(placeLabel);
}

/** Two local-radial altitude rulers, following the Bernstein viewer's 100 km ticks. */
export function makeAltitudeGrid(stationLat: number, stationLon: number) {
  const group = new THREE.Group();
  group.name = "Geographic altitude axes";
  const basis = localBasis(stationLat, stationLon);
  for (const anchor of ALTITUDE_ANCHORS) addAltitudeAxis(group, anchor, basis);
  group.renderOrder = 1000;
  return group;
}
