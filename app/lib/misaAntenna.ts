import * as THREE from "three";

const DISH_DIAMETER_KM = 0.046;
const DISH_RADIUS_KM = DISH_DIAMETER_KM / 2;
const FOCAL_LENGTH_KM = DISH_DIAMETER_KM * 0.36;

export type MisaAntenna = {
  root: THREE.Group;
  azimuthAxis: THREE.Group;
  elevationAxis: THREE.Group;
};

function cylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 6),
    material,
  );
  mesh.position.copy(midpoint);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function makeParaboloid() {
  const radialSegments = 12;
  const angularSegments = 64;
  const vertices: number[] = [0, 0, 0];
  const indices: number[] = [];

  for (let ring = 1; ring <= radialSegments; ring += 1) {
    const radius = DISH_RADIUS_KM * ring / radialSegments;
    const z = -(radius * radius) / (4 * FOCAL_LENGTH_KM);
    for (let sector = 0; sector < angularSegments; sector += 1) {
      const angle = sector / angularSegments * Math.PI * 2;
      vertices.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
  }

  for (let sector = 0; sector < angularSegments; sector += 1) {
    indices.push(0, 1 + sector, 1 + (sector + 1) % angularSegments);
  }
  for (let ring = 1; ring < radialSegments; ring += 1) {
    const inner = 1 + (ring - 1) * angularSegments;
    const outer = inner + angularSegments;
    for (let sector = 0; sector < angularSegments; sector += 1) {
      const next = (sector + 1) % angularSegments;
      indices.push(
        inner + sector,
        outer + sector,
        inner + next,
        inner + next,
        outer + sector,
        outer + next,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeReflector() {
  const reflector = new THREE.Group();
  const geometry = makeParaboloid();
  reflector.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0xb9c2c8,
        metalness: 0.82,
        roughness: 0.48,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    ),
  );
  reflector.add(
    new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xdce4e8, transparent: true, opacity: 0.78 }),
    ),
  );

  const steel = new THREE.MeshStandardMaterial({ color: 0x6d7478, metalness: 0.76, roughness: 0.62 });
  const feed = new THREE.Mesh(
    new THREE.CylinderGeometry(0.00048, 0.00062, 0.0018, 12),
    new THREE.MeshStandardMaterial({ color: 0xc9a569, metalness: 0.68, roughness: 0.42 }),
  );
  feed.rotation.x = Math.PI / 2;
  feed.position.z = -FOCAL_LENGTH_KM;
  reflector.add(feed);

  for (const angle of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) {
    const rim = new THREE.Vector3(
      DISH_RADIUS_KM * Math.cos(angle),
      DISH_RADIUS_KM * Math.sin(angle),
      -(DISH_RADIUS_KM * DISH_RADIUS_KM) / (4 * FOCAL_LENGTH_KM),
    );
    reflector.add(cylinderBetween(rim, new THREE.Vector3(0, 0, -FOCAL_LENGTH_KM), 0.00016, steel));
  }
  return reflector;
}

/** Build the 46 m MISA with a nested azimuth/elevation mount, in kilometre units. */
export function makeMisaAntenna(): MisaAntenna {
  const root = new THREE.Group();
  root.name = "MISA 46 m antenna";
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8b8d88, roughness: 0.94 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x4d5559, metalness: 0.7, roughness: 0.65 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x5e4b3d, metalness: 0.45, roughness: 0.78 });

  const foundation = new THREE.Mesh(new THREE.CylinderGeometry(0.0155, 0.017, 0.0022, 32), concrete);
  foundation.position.y = 0.0011;
  root.add(foundation);

  const azimuthAxis = new THREE.Group();
  azimuthAxis.position.y = 0.0022;
  root.add(azimuthAxis);
  const turntable = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0125, 0.0028, 24), rust);
  turntable.position.y = 0.0014;
  azimuthAxis.add(turntable);

  const pivotHeight = 0.022;
  const yokeHalfWidth = 0.015;
  const footLeft = new THREE.Vector3(-0.0105, 0.003, 0);
  const footRight = new THREE.Vector3(0.0105, 0.003, 0);
  const pivotLeft = new THREE.Vector3(-yokeHalfWidth, pivotHeight, 0);
  const pivotRight = new THREE.Vector3(yokeHalfWidth, pivotHeight, 0);
  azimuthAxis.add(cylinderBetween(footLeft, pivotLeft, 0.00105, steel));
  azimuthAxis.add(cylinderBetween(footRight, pivotRight, 0.00105, steel));
  azimuthAxis.add(cylinderBetween(footLeft, pivotRight, 0.00055, rust));
  azimuthAxis.add(cylinderBetween(footRight, pivotLeft, 0.00055, rust));

  const elevationAxis = new THREE.Group();
  elevationAxis.position.y = pivotHeight;
  azimuthAxis.add(elevationAxis);
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, yokeHalfWidth * 2.2, 12), steel);
  axle.rotation.z = Math.PI / 2;
  elevationAxis.add(axle);
  elevationAxis.add(makeReflector());

  const ambient = new THREE.HemisphereLight(0xddeeff, 0x17222b, 1.7);
  root.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-0.04, 0.07, 0.03);
  root.add(sun);

  return { root, azimuthAxis, elevationAxis };
}

/** Point the physical boresight using azimuth east of north and elevation above horizon. */
export function pointMisaAntenna(antenna: MisaAntenna, azimuthDeg: number, elevationDeg: number) {
  antenna.azimuthAxis.rotation.y = -THREE.MathUtils.degToRad(azimuthDeg);
  antenna.elevationAxis.rotation.x = THREE.MathUtils.degToRad(elevationDeg);
}

export function misaBoresight(azimuthDeg: number, elevationDeg: number) {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    -Math.cos(elevation) * Math.cos(azimuth),
  );
}
