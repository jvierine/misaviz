import * as THREE from "three";

type EclipsePoint = readonly [unix: number, latitude: number, longitude: number];

// WGS-84 central-line coordinates from the NASA/GSFC 2024-04-08 path table.
// Values are more tightly sampled while the shadow crosses the northeastern US.
const ECLIPSE_TRACK: readonly EclipsePoint[] = [
  [Date.UTC(2024, 3, 8, 16, 40) / 1000, -7.5150, -156.4000],
  [Date.UTC(2024, 3, 8, 17, 0) / 1000, 1.7317, -129.6483],
  [Date.UTC(2024, 3, 8, 17, 20) / 1000, 8.3600, -120.5667],
  [Date.UTC(2024, 3, 8, 17, 40) / 1000, 14.4717, -114.1833],
  [Date.UTC(2024, 3, 8, 18, 0) / 1000, 20.3367, -108.7417],
  [Date.UTC(2024, 3, 8, 18, 20) / 1000, 26.0717, -103.3683],
  [Date.UTC(2024, 3, 8, 18, 40) / 1000, 31.7367, -97.3433],
  [Date.UTC(2024, 3, 8, 19, 0) / 1000, 37.3450, -89.7433],
  [Date.UTC(2024, 3, 8, 19, 6) / 1000, 39.0083, -86.9500],
  [Date.UTC(2024, 3, 8, 19, 10) / 1000, 40.1100, -84.9017],
  [Date.UTC(2024, 3, 8, 19, 14) / 1000, 41.2000, -82.6783],
  [Date.UTC(2024, 3, 8, 19, 18) / 1000, 42.2800, -80.2467],
  [Date.UTC(2024, 3, 8, 19, 20) / 1000, 42.8133, -78.9417],
  [Date.UTC(2024, 3, 8, 19, 22) / 1000, 43.3417, -77.5717],
  [Date.UTC(2024, 3, 8, 19, 24) / 1000, 43.8650, -76.1267],
  [Date.UTC(2024, 3, 8, 19, 26) / 1000, 44.3817, -74.6017],
  [Date.UTC(2024, 3, 8, 19, 28) / 1000, 44.8900, -72.9867],
  [Date.UTC(2024, 3, 8, 19, 30) / 1000, 45.3900, -71.2733],
  [Date.UTC(2024, 3, 8, 19, 32) / 1000, 45.8800, -69.4467],
  [Date.UTC(2024, 3, 8, 19, 34) / 1000, 46.3567, -67.4933],
  [Date.UTC(2024, 3, 8, 19, 36) / 1000, 46.8183, -65.3967],
  [Date.UTC(2024, 3, 8, 19, 38) / 1000, 47.2617, -63.1317],
  [Date.UTC(2024, 3, 8, 19, 40) / 1000, 47.6817, -60.6683],
  [Date.UTC(2024, 3, 8, 19, 50) / 1000, 49.1150, -43.0750],
  [Date.UTC(2024, 3, 8, 19, 54) / 1000, 48.4333, -26.8667],
];

export const UMBRA_ANGLE_RAD = 0.014;
export const PENUMBRA_ANGLE_RAD = 0.58;

function direction(latitude: number, longitude: number): THREE.Vector3 {
  const lat = THREE.MathUtils.degToRad(latitude);
  const lon = THREE.MathUtils.degToRad(longitude);
  return new THREE.Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  );
}

function julianDate(unix: number): number {
  return unix / 86_400 + 2_440_587.5;
}

function greenwichMeanSiderealTime(julian: number): number {
  const centuries = (julian - 2_451_545.0) / 36_525;
  const degrees = 280.46061837 + 360.98564736629 * (julian - 2_451_545.0)
    + 0.000387933 * centuries * centuries
    - (centuries * centuries * centuries) / 38_710_000;
  return THREE.MathUtils.degToRad(THREE.MathUtils.euclideanModulo(degrees, 360));
}

/** Low-order solar ephemeris transformed from ECI to ECEF, as in the reference viewer. */
export function sunDirectionEcef(unix: number): THREE.Vector3 {
  const julian = julianDate(unix);
  const days = julian - 2_451_545.0;
  const meanLongitude = THREE.MathUtils.degToRad(
    THREE.MathUtils.euclideanModulo(280.460 + 0.9856474 * days, 360),
  );
  const anomaly = THREE.MathUtils.degToRad(
    THREE.MathUtils.euclideanModulo(357.528 + 0.9856003 * days, 360),
  );
  const eclipticLongitude = meanLongitude
    + THREE.MathUtils.degToRad(1.915) * Math.sin(anomaly)
    + THREE.MathUtils.degToRad(0.020) * Math.sin(2 * anomaly);
  const obliquity = THREE.MathUtils.degToRad(23.439 - 0.0000004 * days);
  const eci = new THREE.Vector3(
    Math.cos(eclipticLongitude),
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  ).normalize();
  const gmst = greenwichMeanSiderealTime(julian);
  const cosine = Math.cos(gmst);
  const sine = Math.sin(gmst);
  return new THREE.Vector3(
    cosine * eci.x + sine * eci.y,
    -sine * eci.x + cosine * eci.y,
    eci.z,
  ).normalize();
}

export function eclipseState(unix: number, stationLat: number, stationLon: number) {
  const first = ECLIPSE_TRACK[0];
  const last = ECLIPSE_TRACK[ECLIPSE_TRACK.length - 1];
  if (unix < first[0] || unix > last[0]) {
    return { center: direction(first[1], first[2]), strength: 0, label: "NO ECLIPSE" };
  }

  let right = 1;
  while (right < ECLIPSE_TRACK.length - 1 && ECLIPSE_TRACK[right][0] < unix) right += 1;
  const a = ECLIPSE_TRACK[right - 1];
  const b = ECLIPSE_TRACK[right];
  const fraction = THREE.MathUtils.clamp((unix - a[0]) / (b[0] - a[0]), 0, 1);
  const center = direction(a[1], a[2]).lerp(direction(b[1], b[2]), fraction).normalize();
  const edgeFade = Math.min((unix - first[0]) / 180, (last[0] - unix) / 180, 1);
  const stationDistance = center.angleTo(direction(stationLat, stationLon));
  const label = stationDistance < UMBRA_ANGLE_RAD
    ? "UMBRA"
    : stationDistance < PENUMBRA_ANGLE_RAD
      ? "PENUMBRA"
      : "ECLIPSE";
  return { center, strength: Math.max(0, edgeFade), label };
}
