"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  eclipseState,
  PENUMBRA_ANGLE_RAD,
  sunDirectionEcef,
  UMBRA_ANGLE_RAD,
} from "../lib/eclipse";
import { decodeFloat16, normalizeFloat16 } from "../lib/float16";
import { makeAltitudeGrid, setAltitudeLabelsVisible } from "../lib/altitudeGrid";
import {
  makeBeamFootprints,
  updateBeamFootprints,
  type BeamFootprints,
} from "../lib/beamFootprints";
import { makeMisaAntenna, pointMisaAntenna, type MisaAntenna } from "../lib/misaAntenna";

type ArraySpec = { offset: number; count: number; type: "u32" | "u16" | "f16" };
type ParameterKey = "logNe" | "ti" | "te" | "vi";
type Manifest = {
  description: string;
  binary: string;
  binaryBytes: number;
  recordCount: number;
  pointCount: number;
  startUnix: number;
  endUnix: number;
  scanDurationSeconds: number;
  station: { name: string; lat: number; lon: number; altKm: number };
  parameterRanges: Record<ParameterKey, [number, number]>;
  arrays: Record<string, ArraySpec>;
};

type Engine = {
  material: THREE.ShaderMaterial;
  earthMaterial: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  sourceIndex: Uint32Array;
  parameters: Record<ParameterKey, Float32Array>;
  timestamps: Uint32Array;
  azimuth: Float32Array;
  elevation: Float32Array;
  pointRecordIndex: Uint16Array;
  recordStarts: Int32Array;
  recordCounts: Uint16Array;
  positions: Float32Array;
  beamGeometry: THREE.BufferGeometry;
  altitudeGrid: THREE.Group;
  beamFootprints: BeamFootprints;
  antenna: MisaAntenna;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
};

type RecordLookup = { starts: Int32Array; counts: Uint16Array };

const PARAMETER_META: Record<
  ParameterKey,
  { label: string; unit: string; decimals: number }
> = {
  logNe: { label: "Electron density", unit: "m⁻³", decimals: 1 },
  ti: { label: "Ion temperature", unit: "K", decimals: 0 },
  te: { label: "Electron temperature", unit: "K", decimals: 0 },
  vi: { label: "Line-of-sight ion velocity", unit: "m s⁻¹", decimals: 0 },
};

const EARTH_RADIUS_KM = 6371;
const DEFAULT_PLAYBACK_RATE = 2400;
const ECLIPSE_INITIAL_TIME = Date.UTC(2024, 3, 8, 19, 29, 0) / 1000;

function assetUrl(path: string): string {
  // Keep browser-loaded data and textures relative to the deployed page. The
  // Apache packager prefixes module assets with /misa/, so normalize either
  // source form to one relative URL and avoid a duplicated /misa/misa path.
  return `./${path.replace(/^\/?(?:misa\/)?/, "")}`;
}

function view<T extends Uint16Array | Uint32Array>(
  buffer: ArrayBuffer,
  spec: ArraySpec,
  ctor: { new (buffer: ArrayBuffer, byteOffset: number, length: number): T },
): T {
  return new ctor(buffer, spec.offset, spec.count);
}

function nearestTimeIndex(timestamps: Uint32Array, target: number): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if (timestamps[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === timestamps.length) return timestamps.length - 1;
  return target - timestamps[low - 1] <= timestamps[low] - target ? low - 1 : low;
}

function formatUtc(unix: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(unix * 1000));
}

function ParameterSymbol({ parameter }: { parameter: ParameterKey }) {
  if (parameter === "logNe") return <>log<sub>10</sub>&thinsp;<i>n</i><sub>e</sub></>;
  if (parameter === "ti") return <><i>T</i><sub>i</sub></>;
  if (parameter === "te") return <><i>T</i><sub>e</sub></>;
  return <><i>v</i><sub>i</sub></>;
}

function makeEarthMaterial(texture: THREE.Texture) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTexture: { value: texture },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uShadowCenter: { value: new THREE.Vector3(1, 0, 0) },
      uShadowStrength: { value: 0 },
      uUmbraAngle: { value: UMBRA_ANGLE_RAD },
      uPenumbraAngle: { value: PENUMBRA_ANGLE_RAD },
    },
    vertexShader: `
      attribute vec3 aEcef;
      varying vec3 vEcef;
      varying vec3 vNormalView;
      void main() {
        vEcef = normalize(aEcef);
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexture;
      uniform vec3 uSunDirection;
      uniform vec3 uShadowCenter;
      uniform float uShadowStrength;
      uniform float uUmbraAngle;
      uniform float uPenumbraAngle;
      varying vec3 vEcef;
      varying vec3 vNormalView;
      const float PI = 3.141592653589793;
      void main() {
        vec3 ecef = normalize(vEcef);
        float longitude = atan(ecef.y, ecef.x);
        float latitude = asin(clamp(ecef.z, -1.0, 1.0));
        // Match the NASA Blue Marble equirectangular convention used by the
        // reference Sanya viewer: north is v=1 and west/east is u=0/1.
        vec2 uv = vec2(fract(longitude / (2.0 * PI) + 0.5), 0.5 + latitude / PI);
        vec3 surface = texture2D(uTexture, uv).rgb;
        surface = mix(surface, sqrt(max(surface, vec3(0.0))), 0.72);
        float solarCosine = dot(ecef, normalize(uSunDirection));
        float daylight = smoothstep(-0.10, 0.12, solarCosine);
        // This local viewport covers the daytime Millstone Hill observation.
        // Preserve the Blue Marble detail while retaining a subtle terminator.
        float light = 0.82 + 0.18 * daylight;
        float shadowAngle = acos(clamp(dot(ecef, normalize(uShadowCenter)), -1.0, 1.0));
        float penumbra = 1.0 - smoothstep(uUmbraAngle, uPenumbraAngle, shadowAngle);
        float umbra = 1.0 - smoothstep(uUmbraAngle * 0.65, uUmbraAngle * 1.35, shadowAngle);
        float eclipseDarkening = uShadowStrength * daylight * (0.28 * penumbra + 0.52 * umbra);
        light *= 1.0 - eclipseDarkening;
        float aerial = pow(max(0.0, 1.0 - abs(dot(normalize(vNormalView), vec3(0.0, 0.0, 1.0)))), 3.0);
        float shadowRim = uShadowStrength * daylight * (1.0 - smoothstep(uPenumbraAngle * 0.96, uPenumbraAngle, shadowAngle));
        shadowRim *= smoothstep(uPenumbraAngle * 0.90, uPenumbraAngle * 0.98, shadowAngle);
        gl_FragColor = vec4(surface * light + vec3(0.02, 0.08, 0.14) * aerial + vec3(0.20, 0.03, 0.34) * shadowRim, 1.0);
      }
    `,
  });
}

function makeEarthPatchGeometry(stationLat: number, stationLon: number) {
  // A complete globe prevents any map boundary from entering the viewport at
  // maximum zoom. Its north pole is remapped into ECEF by the local basis below.
  const geometry = new THREE.SphereGeometry(EARTH_RADIUS_KM, 256, 128);
  geometry.translate(0, -EARTH_RADIUS_KM, 0);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const ecefDirections = new Float32Array(positions.count * 3);
  const lat = THREE.MathUtils.degToRad(stationLat);
  const lon = THREE.MathUtils.degToRad(stationLon);
  const stationUp = new THREE.Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  );
  const eastBasis = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const northBasis = new THREE.Vector3(
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat),
  );
  const direction = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    const eastKm = positions.getX(index);
    const upFromCenterKm = positions.getY(index) + EARTH_RADIUS_KM;
    const northKm = -positions.getZ(index);
    direction.copy(stationUp).multiplyScalar(upFromCenterKm / EARTH_RADIUS_KM)
      .addScaledVector(eastBasis, eastKm / EARTH_RADIUS_KM)
      .addScaledVector(northBasis, northKm / EARTH_RADIUS_KM)
      .normalize();
    direction.toArray(ecefDirections, index * 3);
  }
  geometry.setAttribute("aEcef", new THREE.BufferAttribute(ecefDirections, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeRecordLookup(pointRecordIndex: Uint16Array, recordCount: number): RecordLookup {
  const starts = new Int32Array(recordCount).fill(-1);
  const counts = new Uint16Array(recordCount);
  for (let point = 0; point < pointRecordIndex.length; point += 1) {
    const record = pointRecordIndex[point];
    if (starts[record] < 0) starts[record] = point;
    counts[record] += 1;
  }
  return { starts, counts };
}

function makePersistenceExpiry(
  timestamps: Uint32Array,
  azimuth: Float32Array,
  pointRecordIndex: Uint16Array,
  startUnix: number,
) {
  const recordExpiry = new Float32Array(timestamps.length).fill(1_000_000_000);
  const nextTimeByAzimuth = new Map<number, number>();
  for (let record = timestamps.length - 1; record >= 0; record -= 1) {
    const azimuthBin = Math.round(azimuth[record] / 5);
    recordExpiry[record] = nextTimeByAzimuth.get(azimuthBin) ?? 1_000_000_000;
    nextTimeByAzimuth.set(azimuthBin, timestamps[record] - startUnix);
  }
  const pointExpiry = new Float32Array(pointRecordIndex.length);
  for (let point = 0; point < pointRecordIndex.length; point += 1) {
    pointExpiry[point] = recordExpiry[pointRecordIndex[point]];
  }
  return pointExpiry;
}

function makeInterpolatedSweepIndex(
  timestamps: Uint32Array,
  azimuth: Float32Array,
  recordLookup: RecordLookup,
): THREE.BufferAttribute {
  const recordCount = timestamps.length;
  const { starts, counts } = recordLookup;

  const indices: number[] = [];
  for (let record = 0; record < recordCount - 1; record += 1) {
    const next = record + 1;
    const timeStep = timestamps[next] - timestamps[record];
    const rawAzimuthStep = Math.abs(azimuth[next] - azimuth[record]);
    const azimuthStep = Math.min(rawAzimuthStep, 360 - rawAzimuthStep);
    const gateCount = Math.min(counts[record], counts[next]);
    // Data records are about 35 seconds and 5 degrees apart. These limits
    // prevent interpolation across observing gaps and wiper turnarounds.
    if (timeStep > 60 || azimuthStep > 8 || gateCount < 2) continue;
    for (let gate = 0; gate < gateCount - 1; gate += 1) {
      const nearA = starts[record] + gate;
      const farA = nearA + 1;
      const nearB = starts[next] + gate;
      const farB = nearB + 1;
      indices.push(nearA, nearB, farA, nearB, farB, farA);
    }
  }
  return new THREE.BufferAttribute(new Uint32Array(indices), 1);
}

function makeNativeSweepGeometry(
  positions: Float32Array,
  pointTimes: Float32Array,
  pointExpiry: Float32Array,
  values: Float32Array,
  indexAttribute: THREE.BufferAttribute,
) {
  const indices = indexAttribute.array as Uint32Array;
  const vertexPositions = new Float32Array(indices.length * 3);
  const vertexTimes = new Float32Array(indices.length);
  const vertexExpiry = new Float32Array(indices.length);
  const vertexValues = new Float32Array(indices.length);
  const sourceIndex = new Uint32Array(indices.length);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    // Both triangles of each range/azimuth cell use the same far, older
    // measurement as their value source. Repeating that value at all three
    // vertices guarantees a native, unsmoothed cell on every WebGL device.
    const source = indices[triangle + 2];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle + corner;
      const positionSource = indices[vertex];
      vertexPositions[vertex * 3] = positions[positionSource * 3];
      vertexPositions[vertex * 3 + 1] = positions[positionSource * 3 + 1];
      vertexPositions[vertex * 3 + 2] = positions[positionSource * 3 + 2];
      vertexTimes[vertex] = pointTimes[source];
      vertexExpiry[vertex] = pointExpiry[source];
      vertexValues[vertex] = values[source];
      sourceIndex[vertex] = source;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertexPositions, 3));
  geometry.setAttribute("aTime", new THREE.BufferAttribute(vertexTimes, 1));
  geometry.setAttribute("aExpiryTime", new THREE.BufferAttribute(vertexExpiry, 1));
  geometry.setAttribute("aValue", new THREE.BufferAttribute(vertexValues, 1));
  return { geometry, sourceIndex };
}

const SWEEP_VERTEX_SHADER = `
  attribute float aValue;
  attribute float aTime;
  attribute float aExpiryTime;
  uniform float uCurrentTime;
  uniform float uFadeWindow;
  uniform float uPersistence;
  varying float vValue;
  varying float vAlpha;
  void main() {
    float age = uCurrentTime - aTime;
    float measured = step(0.0, age);
    float historyAlpha = measured * step(age, uFadeWindow) * clamp(1.0 - age / uFadeWindow, 0.0, 1.0);
    float persistenceAlpha = measured * step(uCurrentTime, aExpiryTime);
    float validValue = step(0.0, aValue);
    vValue = max(0.0, aValue);
    vAlpha = mix(historyAlpha, persistenceAlpha, uPersistence) * validValue;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SWEEP_FRAGMENT_SHADER = `
  uniform float uDiverging;
  uniform float uColorMin;
  uniform float uColorMax;
  varying float vValue;
  varying float vAlpha;

  vec3 turbo(float x) {
    x = clamp(x, 0.0, 1.0);
    vec3 c0 = vec3(0.190, 0.072, 0.232);
    vec3 c1 = vec3(0.155, 0.470, 0.812);
    vec3 c2 = vec3(0.103, 0.824, 0.670);
    vec3 c3 = vec3(0.650, 0.960, 0.204);
    vec3 c4 = vec3(0.985, 0.555, 0.118);
    vec3 c5 = vec3(0.480, 0.016, 0.010);
    float segment = x * 5.0;
    if (segment < 1.0) return mix(c0, c1, segment);
    if (segment < 2.0) return mix(c1, c2, segment - 1.0);
    if (segment < 3.0) return mix(c2, c3, segment - 2.0);
    if (segment < 4.0) return mix(c3, c4, segment - 3.0);
    return mix(c4, c5, segment - 4.0);
  }

  vec3 seismic(float x) {
    x = clamp(x, 0.0, 1.0);
    if (x < 0.5) return mix(vec3(0.03, 0.12, 0.64), vec3(0.96), x * 2.0);
    return mix(vec3(0.96), vec3(0.67, 0.02, 0.05), (x - 0.5) * 2.0);
  }

  void main() {
    if (vAlpha <= 0.001) discard;
    float colorValue = clamp(
      (vValue - uColorMin) / max(uColorMax - uColorMin, 0.0001),
      0.0,
      1.0
    );
    vec3 color = mix(turbo(colorValue), seismic(colorValue), uDiverging);
    gl_FragColor = vec4(color, vAlpha);
  }
`;

export default function MisaViewer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const currentTimeRef = useRef(0);
  const playingRef = useRef(false);
  const playbackRateRef = useRef(DEFAULT_PLAYBACK_RATE);
  const lastUiUpdateRef = useRef(0);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [parameter, setParameter] = useState<ParameterKey>("logNe");
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(DEFAULT_PLAYBACK_RATE);
  const [fadeHistory, setFadeHistory] = useState(true);
  const [showAxisLabels, setShowAxisLabels] = useState(true);
  const [showBeamWidth, setShowBeamWidth] = useState(true);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [colorLimits, setColorLimits] = useState<Record<ParameterKey, [number, number]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const parameterMeta = PARAMETER_META[parameter];
  const parameterRange = manifest?.parameterRanges[parameter];

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    let disposed = false;
    let frame = 0;

    async function initialize() {
      if (!mountRef.current) return;
      try {
        const manifestResponse = await fetch(assetUrl("/data/manifest.json"));
        if (!manifestResponse.ok) throw new Error("Unable to load the MISA manifest");
        const loadedManifest = (await manifestResponse.json()) as Manifest;
        const binaryResponse = await fetch(assetUrl(`/data/${loadedManifest.binary}`));
        if (!binaryResponse.ok) throw new Error("Unable to load the MISA float16 data");
        const binary = await binaryResponse.arrayBuffer();

        const timestamps = view(binary, loadedManifest.arrays.timestamps, Uint32Array);
        const azimuthValues = decodeFloat16(view(binary, loadedManifest.arrays.azimuth, Uint16Array));
        const elevationValues = decodeFloat16(view(binary, loadedManifest.arrays.elevation, Uint16Array));
        const pointRecordIndex = view(binary, loadedManifest.arrays.pointRecordIndex, Uint16Array);
        const x = decodeFloat16(view(binary, loadedManifest.arrays.x, Uint16Array));
        const y = decodeFloat16(view(binary, loadedManifest.arrays.y, Uint16Array));
        const z = decodeFloat16(view(binary, loadedManifest.arrays.z, Uint16Array));
        const positions = new Float32Array(loadedManifest.pointCount * 3);
        const pointTimes = new Float32Array(loadedManifest.pointCount);
        for (let index = 0; index < loadedManifest.pointCount; index += 1) {
          positions[index * 3] = x[index];
          positions[index * 3 + 1] = y[index];
          positions[index * 3 + 2] = z[index];
          pointTimes[index] = timestamps[pointRecordIndex[index]] - loadedManifest.startUnix;
        }
        const recordLookup = makeRecordLookup(pointRecordIndex, loadedManifest.recordCount);
        let northAzimuth = -Infinity;
        let southAzimuth = Infinity;
        let elevationSum = 0;
        for (let index = 0; index < azimuthValues.length; index += 1) {
          northAzimuth = Math.max(northAzimuth, azimuthValues[index]);
          southAzimuth = Math.min(southAzimuth, azimuthValues[index]);
          elevationSum += elevationValues[index];
        }
        const sweepElevation = elevationSum / Math.max(1, elevationValues.length);
        const pointExpiry = makePersistenceExpiry(
          timestamps,
          azimuthValues,
          pointRecordIndex,
          loadedManifest.startUnix,
        );

        const parameters = {} as Record<ParameterKey, Float32Array>;
        for (const key of Object.keys(PARAMETER_META) as ParameterKey[]) {
          const range = loadedManifest.parameterRanges[key];
          parameters[key] = normalizeFloat16(
            view(binary, loadedManifest.arrays[key], Uint16Array),
            range[0],
            range[1],
          );
        }

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x020812);
        scene.fog = new THREE.FogExp2(0x020812, 0.00023);

        const camera = new THREE.PerspectiveCamera(45, 1, 0.2, 50000);
        camera.position.set(-1050, 900, 1060);

        const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        mountRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.07;
        controls.enablePan = false;
        controls.minDistance = 0.055;
        controls.maxDistance = 10000;
        controls.rotateSpeed = 0.55;
        controls.zoomSpeed = 0.8;
        controls.update();

        let texture: THREE.Texture;
        try {
          texture = await new THREE.TextureLoader().loadAsync(assetUrl("/assets/nasa-blue-marble-2004-12.jpg"));
        } catch {
          texture = new THREE.DataTexture(new Uint8Array([18, 38, 54, 255]), 1, 1);
          texture.needsUpdate = true;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = true;
        texture.wrapS = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        const earthGeometry = makeEarthPatchGeometry(
          loadedManifest.station.lat,
          loadedManifest.station.lon,
        );
        const earthMaterial = makeEarthMaterial(texture);
        const earth = new THREE.Mesh(earthGeometry, earthMaterial);
        scene.add(earth);
        const altitudeGrid = makeAltitudeGrid(northAzimuth, southAzimuth, sweepElevation);
        scene.add(altitudeGrid);

        const sweep = makeNativeSweepGeometry(
          positions,
          pointTimes,
          pointExpiry,
          parameters.logNe,
          makeInterpolatedSweepIndex(timestamps, azimuthValues, recordLookup),
        );
        const { geometry } = sweep;
        const material = new THREE.ShaderMaterial({
          uniforms: {
            uCurrentTime: { value: 0 },
            uFadeWindow: { value: loadedManifest.scanDurationSeconds },
            uPersistence: { value: 0 },
            uDiverging: { value: 0 },
            uColorMin: { value: 0 },
            uColorMax: { value: 1 },
          },
          vertexShader: SWEEP_VERTEX_SHADER,
          fragmentShader: SWEEP_FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: THREE.NormalBlending,
          side: THREE.DoubleSide,
        });
        const radarLayer = new THREE.Group();
        radarLayer.visible = true;
        const sweepMesh = new THREE.Mesh(geometry, material);
        sweepMesh.renderOrder = 20;
        radarLayer.add(sweepMesh);
        scene.add(radarLayer);

        const antenna = makeMisaAntenna();
        scene.add(antenna.root);

        const beamGeometry = new THREE.BufferGeometry();
        beamGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(72 * 3), 3));
        const beamLine = new THREE.Line(
          beamGeometry,
          new THREE.LineBasicMaterial({
            color: 0xf7fbff,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            depthWrite: false,
          }),
        );
        beamLine.renderOrder = 21;
        radarLayer.add(beamLine);
        const beamFootprints = makeBeamFootprints();
        radarLayer.add(beamFootprints.group);
        const engine: Engine = {
          material,
          earthMaterial,
          geometry,
          sourceIndex: sweep.sourceIndex,
          parameters,
          timestamps,
          azimuth: azimuthValues,
          elevation: elevationValues,
          pointRecordIndex,
          recordStarts: recordLookup.starts,
          recordCounts: recordLookup.counts,
          positions,
          beamGeometry,
          altitudeGrid,
          beamFootprints,
          antenna,
          renderer,
          controls,
          scene,
          camera,
        };
        engineRef.current = engine;

        const start = THREE.MathUtils.clamp(
          ECLIPSE_INITIAL_TIME,
          loadedManifest.startUnix,
          loadedManifest.endUnix,
        );
        currentTimeRef.current = start;
        setManifest(loadedManifest);
        setColorLimits({
          logNe: [...loadedManifest.parameterRanges.logNe],
          ti: [...loadedManifest.parameterRanges.ti],
          te: [...loadedManifest.parameterRanges.te],
          vi: [...loadedManifest.parameterRanges.vi],
        });
        setCurrentTime(start);
        setLoading(false);

        const resize = () => {
          if (!mountRef.current) return;
          const width = mountRef.current.clientWidth;
          const height = mountRef.current.clientHeight;
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
          renderer.setSize(width, height);
        };
        const observer = new ResizeObserver(resize);
        observer.observe(mountRef.current);
        resize();

        const pressedKeys = new Set<string>();
        let keyboardOrbitVelocity = 0;
        let keyboardElevationVelocity = 0;
        const keydown = (event: KeyboardEvent) => {
          const target = event.target as HTMLElement | null;
          if (target?.matches("input, select, textarea, button")) return;
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          pressedKeys.add(event.key);
        };
        const keyup = (event: KeyboardEvent) => pressedKeys.delete(event.key);
        const clearKeys = () => pressedKeys.clear();
        window.addEventListener("keydown", keydown);
        window.addEventListener("keyup", keyup);
        window.addEventListener("blur", clearKeys);

        let last = performance.now();
        const animate = (now: number) => {
          if (disposed) return;
          const delta = Math.min(0.1, (now - last) / 1000);
          last = now;
          if (playingRef.current) {
            let next = currentTimeRef.current + delta * playbackRateRef.current;
            if (next > loadedManifest.endUnix) next = loadedManifest.startUnix;
            currentTimeRef.current = next;
            if (now - lastUiUpdateRef.current > 70) {
              setCurrentTime(next);
              lastUiUpdateRef.current = now;
            }
          }

          const orbitInput = Number(pressedKeys.has("ArrowLeft")) - Number(pressedKeys.has("ArrowRight"));
          const elevationInput = Number(pressedKeys.has("ArrowDown")) - Number(pressedKeys.has("ArrowUp"));
          const keyboardSpeed = THREE.MathUtils.degToRad(42);
          const response = 1 - Math.exp(-delta * 11);
          keyboardOrbitVelocity = THREE.MathUtils.lerp(keyboardOrbitVelocity, orbitInput * keyboardSpeed, response);
          keyboardElevationVelocity = THREE.MathUtils.lerp(
            keyboardElevationVelocity,
            elevationInput * keyboardSpeed,
            response,
          );
          if (Math.abs(keyboardOrbitVelocity) > 1e-5 || Math.abs(keyboardElevationVelocity) > 1e-5) {
            const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
            spherical.theta += keyboardOrbitVelocity * delta;
            spherical.phi = THREE.MathUtils.clamp(
              spherical.phi + keyboardElevationVelocity * delta,
              0.08,
              Math.PI / 2 - 0.02,
            );
            camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
          }

          const cameraDistance = camera.position.distanceTo(controls.target);
          const nextNear = Math.max(0.0005, cameraDistance / 5000);
          const nextFar = Math.max(6000, cameraDistance * 5);
          if (Math.abs(camera.near - nextNear) / nextNear > 0.01 || Math.abs(camera.far - nextFar) / nextFar > 0.01) {
            camera.near = nextNear;
            camera.far = nextFar;
            camera.updateProjectionMatrix();
          }

          const relativeTime = currentTimeRef.current - loadedManifest.startUnix;
          material.uniforms.uCurrentTime.value = relativeTime;
          const shadow = eclipseState(
            currentTimeRef.current,
            loadedManifest.station.lat,
            loadedManifest.station.lon,
          );
          earthMaterial.uniforms.uSunDirection.value.copy(sunDirectionEcef(currentTimeRef.current));
          earthMaterial.uniforms.uShadowCenter.value.copy(shadow.center);
          earthMaterial.uniforms.uShadowStrength.value = shadow.strength;
          const recordIndex = nearestTimeIndex(timestamps, currentTimeRef.current);
          const beamAttribute = beamGeometry.getAttribute("position") as THREE.BufferAttribute;
          const beamArray = beamAttribute.array as Float32Array;
          let cursor = 1;
          beamArray[0] = 0;
          beamArray[1] = 0.022;
          beamArray[2] = 0;
          const firstPoint = recordLookup.starts[recordIndex];
          const recordEnd = firstPoint + recordLookup.counts[recordIndex];
          for (let point = firstPoint; point < recordEnd && cursor < 72; point += 1) {
            beamArray[cursor * 3] = positions[point * 3];
            beamArray[cursor * 3 + 1] = positions[point * 3 + 1];
            beamArray[cursor * 3 + 2] = positions[point * 3 + 2];
            cursor += 1;
          }
          beamGeometry.setDrawRange(0, cursor);
          beamAttribute.needsUpdate = true;
          if (firstPoint >= 0) {
            const east = positions[firstPoint * 3];
            const up = positions[firstPoint * 3 + 1];
            const south = positions[firstPoint * 3 + 2];
            const horizontal = Math.hypot(east, south);
            const beamAzimuth = THREE.MathUtils.radToDeg(Math.atan2(east, -south));
            const beamElevation = THREE.MathUtils.radToDeg(Math.atan2(up, horizontal));
            pointMisaAntenna(
              antenna,
              beamAzimuth,
              beamElevation,
            );
            updateBeamFootprints(beamFootprints, beamAzimuth, beamElevation);
          }
          controls.update();
          renderer.render(scene, camera);
          frame = requestAnimationFrame(animate);
        };
        frame = requestAnimationFrame(animate);

        return () => {
          observer.disconnect();
          window.removeEventListener("keydown", keydown);
          window.removeEventListener("keyup", keyup);
          window.removeEventListener("blur", clearKeys);
        };
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Unable to initialize the viewer");
        setLoading(false);
      }
    }

    let disconnect: (() => void) | undefined;
    initialize().then((cleanup) => {
      disconnect = cleanup;
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      disconnect?.();
      const engine = engineRef.current;
      if (engine) {
        engine.controls.dispose();
        engine.renderer.dispose();
        engine.renderer.domElement.remove();
      }
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const source = engine.parameters[parameter];
    const values = new Float32Array(engine.sourceIndex.length);
    for (let vertex = 0; vertex < values.length; vertex += 1) values[vertex] = source[engine.sourceIndex[vertex]];
    engine.geometry.setAttribute("aValue", new THREE.BufferAttribute(values, 1));
    engine.material.uniforms.uDiverging.value = parameter === "vi" ? 1 : 0;
  }, [parameter]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.material.uniforms.uPersistence.value = fadeHistory ? 0 : 1;
  }, [fadeHistory]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setAltitudeLabelsVisible(engine.altitudeGrid, showAxisLabels);
  }, [showAxisLabels]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.beamFootprints.group.visible = showBeamWidth;
  }, [showBeamWidth]);

  useEffect(() => {
    const engine = engineRef.current;
    const fullRange = manifest?.parameterRanges[parameter];
    const limits = colorLimits?.[parameter];
    if (!engine || !fullRange || !limits) return;
    const span = Math.max(fullRange[1] - fullRange[0], Number.EPSILON);
    engine.material.uniforms.uColorMin.value = (limits[0] - fullRange[0]) / span;
    engine.material.uniforms.uColorMax.value = (limits[1] - fullRange[0]) / span;
  }, [colorLimits, manifest, parameter]);

  const setTime = (value: number) => {
    currentTimeRef.current = value;
    setCurrentTime(value);
  };

  const activeColorLimits = colorLimits?.[parameter] ?? parameterRange;
  const colorStep = parameterMeta.decimals > 0 ? 10 ** -parameterMeta.decimals : 1;

  const updateColorLimit = (edge: 0 | 1, value: number) => {
    if (!colorLimits || !parameterRange) return;
    const current = colorLimits[parameter];
    const next: [number, number] = [...current];
    if (edge === 0) next[0] = Math.min(value, next[1] - colorStep);
    else next[1] = Math.max(value, next[0] + colorStep);
    setColorLimits({ ...colorLimits, [parameter]: next });
  };

  const legendLabels = useMemo(() => {
    if (!activeColorLimits) return ["", "", ""];
    const decimals = parameterMeta.decimals;
    const middle = (activeColorLimits[0] + activeColorLimits[1]) / 2;
    return [activeColorLimits[0], middle, activeColorLimits[1]].map((value) => value.toFixed(decimals));
  }, [activeColorLimits, parameterMeta.decimals]);

  return (
    <main className="viewer-shell">
      <div ref={mountRef} className="webgl-stage" aria-label="Interactive MISA radar scan visualization" />
      <div className="vignette" aria-hidden="true" />

      <a className="haystack-mark" href="https://www.haystack.mit.edu/" target="_blank" rel="noreferrer" aria-label="MIT Haystack Observatory">
        {/* A direct URL is required because this site is a backend-free static export. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={assetUrl("/assets/mit-haystack.png")} alt="MIT Haystack Observatory" width={978} height={1103} />
      </a>

      <section className={`control-deck${controlsCollapsed ? " collapsed" : ""}`} aria-label="Viewer configuration">
        <button
          className="collapse-button"
          type="button"
          aria-label={controlsCollapsed ? "Show viewer controls" : "Hide viewer controls"}
          aria-expanded={!controlsCollapsed}
          onClick={() => setControlsCollapsed((value) => !value)}
        >
          {controlsCollapsed ? "☰" : "−"}
        </button>
        <button
          className="play-button"
          type="button"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? "Pause animation" : "Play animation"}
          disabled={loading || Boolean(error)}
        >
          {playing ? "Ⅱ" : "▶"}
        </button>

        <div className="time-control">
          <div className="time-row">
            <time>{manifest ? `${formatUtc(currentTime)} UTC` : "Loading observation…"}</time>
            <span>{playing ? `${playbackRate.toLocaleString()}×` : "SCRUB"}</span>
          </div>
          <input
            aria-label="Observation time"
            type="range"
            min={manifest?.startUnix ?? 0}
            max={manifest?.endUnix ?? 1}
            step="1"
            value={currentTime || manifest?.startUnix || 0}
            onChange={(event) => setTime(Number(event.target.value))}
            disabled={!manifest}
          />
          <div className="range-dates"><span>07 APR</span><span>08 APR</span><span>09 APR 2024</span></div>
          <label className="speed-control">
            <span>SPEED <b>{playbackRate.toLocaleString()}×</b></span>
            <input
              aria-label="Animation speed"
              type="range"
              min="60"
              max="7200"
              step="60"
              value={playbackRate}
              onChange={(event) => setPlaybackRate(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="parameter-select">
          <span>PLASMA PARAMETER</span>
          <select aria-label="Plasma parameter" value={parameter} onChange={(event) => setParameter(event.target.value as ParameterKey)}>
            {(Object.keys(PARAMETER_META) as ParameterKey[]).map((key) => (
              <option key={key} value={key}>{PARAMETER_META[key].label}</option>
            ))}
          </select>
          <div className="toggle-row">
            <label className="viewer-toggle">
              <input type="checkbox" checked={fadeHistory} onChange={(event) => setFadeHistory(event.target.checked)} />
              <span>FADE HISTORY</span>
            </label>
            <label className="viewer-toggle">
              <input type="checkbox" checked={showAxisLabels} onChange={(event) => setShowAxisLabels(event.target.checked)} />
              <span>AXIS LABELS</span>
            </label>
            <label className="viewer-toggle">
              <input type="checkbox" checked={showBeamWidth} onChange={(event) => setShowBeamWidth(event.target.checked)} />
              <span>BEAM WIDTH</span>
            </label>
          </div>
        </div>

        <div className="legend">
          <div className="legend-title"><span className="math-symbol"><ParameterSymbol parameter={parameter} /></span><small>{parameterMeta.unit}</small></div>
          <div className={`colorbar ${parameter === "vi" ? "seismic" : "turbo"}`} />
          <div className="legend-values">{legendLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
          {parameterRange && activeColorLimits && (
            <div className="color-limit-controls">
              <label>
                <span>MIN <b>{activeColorLimits[0].toFixed(parameterMeta.decimals)}</b></span>
                <input
                  aria-label="Colorbar minimum"
                  type="range"
                  min={parameterRange[0]}
                  max={parameterRange[1]}
                  step="any"
                  value={activeColorLimits[0]}
                  onChange={(event) => updateColorLimit(0, Number(event.target.value))}
                />
              </label>
              <label>
                <span>MAX <b>{activeColorLimits[1].toFixed(parameterMeta.decimals)}</b></span>
                <input
                  aria-label="Colorbar maximum"
                  type="range"
                  min={parameterRange[0]}
                  max={parameterRange[1]}
                  step="any"
                  value={activeColorLimits[1]}
                  onChange={(event) => updateColorLimit(1, Number(event.target.value))}
                />
              </label>
            </div>
          )}
        </div>
      </section>

      <p className="gesture-hint">Drag or ← → orbit · ↑ ↓ elevation · wheel or pinch zoom</p>
      <a className="eclipse-credit" href="https://eclipse.gsfc.nasa.gov/SEhistory/SEpath/SE2024Apr08Tpath.html" target="_blank" rel="noreferrer">
        Eclipse predictions: Fred Espenak, NASA/GSFC
      </a>

      {loading && <div className="loading-card"><span className="loader" />Preparing the Earth view…</div>}
      {error && <div className="error-card">{error}</div>}
    </main>
  );
}
