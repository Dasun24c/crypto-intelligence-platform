import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ActivityFeed } from '../../live/activity-hooks.js';
import { type BrainLayout, buildLayout, MAX_PARTICLES } from '../../lib/brain/layout.js';
import {
  type BrainParams,
  IDLE_PARAMS,
  type LivePulse,
  livePulses,
  MAX_PULSES,
  pulseAnchor,
  smoothParams,
  targetParams,
} from '../../lib/brain/mapping.js';
import { type QualityChoice, QualityController, type QualityTier, TIER } from '../../lib/brain/quality.js';
import { brainState, REGION_COLOUR, REGIONS } from '../../lib/brain/state.js';

/**
 * The 3D brain (Phase 10, ADR 024): React Three Fiber over three.js, in this lazy chunk. Every frame
 * it reads the activity feed, works out the state and the target parameters (pure functions), moves
 * the shown parameters towards them, and writes them to the shaders' uniforms. Particles move on the
 * GPU along seeded paths; nothing on screen is random, and nothing moves faster than the activity.
 */

export interface Telemetry {
  fps: number | null;
  tier: QualityTier;
  frames: number;
}

interface FrameReport extends Telemetry {
  state: string;
  pulses: number;
}

export interface BrainSceneProps {
  feed: { readonly current: ActivityFeed };
  live: boolean;
  quality: QualityChoice;
  frameloop: 'never' | 'demand' | 'always';
  reducedMotion: boolean;
  /** Changes whenever the snapshot or the state does: with reduced motion, a still frame is drawn for it. */
  revision: number;
  onTelemetry: (t: Telemetry) => void;
}

/** Paths a second along which a particle travels at full speed. */
const FLOW_RATE = 0.35;
/** The longest frame step the animation takes (a stalled frame does not jump). */
const MAX_STEP_S = 0.25;
const TELEMETRY_EVERY_MS = 500;

const NODE_VERTEX = /* glsl */ `
attribute float aRegion;
attribute float aPhase;
uniform vec3 uColors[4];
uniform float uGlow[4];
uniform float uAlarm[4];
uniform float uFire;
uniform float uTime;
uniform float uBreath;
uniform float uBrightness;
uniform float uSaturation;
uniform vec4 uPulse[${MAX_PULSES}];
uniform float uPulseWave[${MAX_PULSES}];
uniform float uPulseAge[${MAX_PULSES}];
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  int r = int(aRegion + 0.5);
  vec3 base = uColors[0];
  float glow = uGlow[0];
  float alarm = uAlarm[0];
  if (r == 1) { base = uColors[1]; glow = uGlow[1]; alarm = uAlarm[1]; }
  else if (r == 2) { base = uColors[2]; glow = uGlow[2]; alarm = uAlarm[2]; }
  else if (r == 3) { base = uColors[3]; glow = uGlow[3]; alarm = uAlarm[3]; }
  // Each node flashes once per firing cycle, at its own place in it.
  float cycle = fract(aPhase + uFire);
  float flash = pow(1.0 - cycle, 14.0);
  float boost = 0.0;
  for (int i = 0; i < ${MAX_PULSES}; i++) {
    float s = uPulse[i].w;
    if (s > 0.0) {
      float d = distance(position, uPulse[i].xyz);
      if (uPulseWave[i] > 0.5) {
        float ring = uPulseAge[i] * 1.1;
        boost += s * exp(-pow((d - ring) / 0.14, 2.0));
      } else {
        boost += s * exp(-pow(d / 0.3, 2.0));
      }
    }
  }
  vec3 colour = base * (0.3 + 0.9 * glow + 0.9 * flash * (0.35 + glow)) + vec3(0.75 * boost);
  float crit = smoothstep(0.6, 1.0, alarm);
  float warn = smoothstep(0.2, 0.5, alarm) * (1.0 - crit);
  colour = mix(colour, vec3(1.0, 0.72, 0.2), warn * 0.55);
  colour = mix(colour, vec3(1.0, 0.18, 0.16) * (0.75 + 0.25 * sin(uTime * 6.2832)), crit * 0.85);
  float grey = dot(colour, vec3(0.299, 0.587, 0.114));
  vColor = mix(vec3(grey), colour, uSaturation) * uBrightness;
  float breath = 1.0 + 0.045 * uBreath * sin(uTime * 1.0472);
  vec4 mv = modelViewMatrix * vec4(position * breath, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (2.4 + 3.2 * flash + 5.0 * min(boost, 1.5)) * uPixelRatio * (3.2 / -mv.z);
}`;

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aB;
attribute vec3 aC;
attribute float aOffset;
attribute float aRate;
uniform float uTravel;
uniform float uSpeed;
uniform float uTime;
uniform float uBreath;
uniform float uBrightness;
uniform float uSaturation;
uniform vec3 uFrom;
uniform vec3 uTo;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  // Along a curve from an ingestion node, bending through analysis, to AI or alerts.
  float u = fract(aOffset + uTravel * aRate);
  float v = 1.0 - u;
  vec3 p = v * v * position + 2.0 * v * u * aB + u * u * aC;
  vAlpha = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.9, 1.0, u)) * (0.35 + 0.65 * uSpeed);
  vec3 colour = mix(uFrom, uTo, u);
  float grey = dot(colour, vec3(0.299, 0.587, 0.114));
  vColor = mix(vec3(grey), colour, uSaturation) * uBrightness;
  float breath = 1.0 + 0.045 * uBreath * sin(uTime * 1.0472);
  vec4 mv = modelViewMatrix * vec4(p * breath, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.4 + 1.4 * uSpeed) * uPixelRatio * (3.2 / -mv.z);
}`;

const POINT_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.05, d) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;

const NODE_FRAGMENT = POINT_FRAGMENT.replace('varying float vAlpha;', 'const float vAlpha = 1.0;');

interface Objects {
  group: THREE.Group;
  update(
    p: BrainParams,
    clocks: Clocks,
    pulses: readonly LivePulse[],
    pixelRatio: number,
    particles: number,
  ): void;
  dispose(): void;
}

interface Clocks {
  time: number;
  travel: number;
  fire: number;
}

/** The scene's objects, made once from the seeded layout. */
function makeObjects(layout: BrainLayout): Objects {
  const colours = REGIONS.map((r) => new THREE.Color(REGION_COLOUR[r]));
  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute('position', new THREE.BufferAttribute(layout.positions, 3));
  nodeGeometry.setAttribute('aRegion', new THREE.BufferAttribute(Float32Array.from(layout.regions), 1));
  nodeGeometry.setAttribute('aPhase', new THREE.BufferAttribute(layout.phases, 1));
  const nodeUniforms = {
    uColors: { value: colours },
    uGlow: { value: [0, 0, 0, 0] },
    uAlarm: { value: [0, 0, 0, 0] },
    uFire: { value: 0 },
    uTime: { value: 0 },
    uBreath: { value: 1 },
    uBrightness: { value: 1 },
    uSaturation: { value: 1 },
    uPulse: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector4()) },
    uPulseWave: { value: Array.from({ length: MAX_PULSES }, () => 0) },
    uPulseAge: { value: Array.from({ length: MAX_PULSES }, () => 0) },
    uPixelRatio: { value: 1 },
  };
  const nodeMaterial = new THREE.ShaderMaterial({
    uniforms: nodeUniforms,
    vertexShader: NODE_VERTEX,
    fragmentShader: NODE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const nodes = new THREE.Points(nodeGeometry, nodeMaterial);

  const linkPositions = new Float32Array(layout.links.length * 3);
  const linkColours = new Float32Array(layout.links.length * 3);
  layout.links.forEach((node, k) => {
    for (let c = 0; c < 3; c++) linkPositions[k * 3 + c] = layout.positions[node * 3 + c]!;
    const colour = colours[layout.regions[node]!]!;
    linkColours.set([colour.r * 0.6, colour.g * 0.6, colour.b * 0.6], k * 3);
  });
  const linkGeometry = new THREE.BufferGeometry();
  linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
  linkGeometry.setAttribute('color', new THREE.BufferAttribute(linkColours, 3));
  const linkMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const links = new THREE.LineSegments(linkGeometry, linkMaterial);

  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(layout.particleA, 3));
  particleGeometry.setAttribute('aB', new THREE.BufferAttribute(layout.particleB, 3));
  particleGeometry.setAttribute('aC', new THREE.BufferAttribute(layout.particleC, 3));
  particleGeometry.setAttribute('aOffset', new THREE.BufferAttribute(layout.particleOffset, 1));
  particleGeometry.setAttribute('aRate', new THREE.BufferAttribute(layout.particleRate, 1));
  const particleUniforms = {
    uTravel: { value: 0 },
    uSpeed: { value: 0 },
    uTime: { value: 0 },
    uBreath: { value: 1 },
    uBrightness: { value: 1 },
    uSaturation: { value: 1 },
    uFrom: { value: colours[0]!.clone() },
    uTo: { value: colours[1]!.clone() },
    uPixelRatio: { value: 1 },
  };
  const particleMaterial = new THREE.ShaderMaterial({
    uniforms: particleUniforms,
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  // Their positions are computed in the shader: the start points' bounds say nothing about them.
  particles.frustumCulled = false;

  const group = new THREE.Group();
  group.add(links, particles, nodes);
  // A fixed three-quarter view: the back (ingestion) on the left, the front (AI) on the right.
  group.rotation.set(0.28, -0.62, 0);

  return {
    group,
    update(p, clocks, pulses, pixelRatio, particleCount) {
      REGIONS.forEach((r, i) => {
        nodeUniforms.uGlow.value[i] = p.glow[r];
        nodeUniforms.uAlarm.value[i] = p.alarm[r];
      });
      nodeUniforms.uFire.value = clocks.fire;
      nodeUniforms.uTime.value = clocks.time;
      nodeUniforms.uBreath.value = p.breathing;
      nodeUniforms.uBrightness.value = p.brightness;
      nodeUniforms.uSaturation.value = p.saturation;
      nodeUniforms.uPixelRatio.value = pixelRatio;
      for (let i = 0; i < MAX_PULSES; i++) {
        const shown = pulses[i];
        const v = nodeUniforms.uPulse.value[i]!;
        if (!shown) {
          v.set(0, 0, 0, 0);
          continue;
        }
        const ids = layout.byRegion[shown.region];
        const anchor = ids[pulseAnchor(shown.pulse.refId, ids.length)] ?? 0;
        v.set(
          layout.positions[anchor * 3]!,
          layout.positions[anchor * 3 + 1]!,
          layout.positions[anchor * 3 + 2]!,
          shown.strength,
        );
        nodeUniforms.uPulseWave.value[i] = shown.shape === 'wave' ? 1 : 0;
        nodeUniforms.uPulseAge.value[i] = (Date.now() - shown.at) / 1000;
      }
      particleUniforms.uTravel.value = clocks.travel;
      particleUniforms.uSpeed.value = p.particleSpeed;
      particleUniforms.uTime.value = clocks.time;
      particleUniforms.uBreath.value = p.breathing;
      particleUniforms.uBrightness.value = p.brightness * (0.4 + 0.6 * p.glow.ingestion);
      particleUniforms.uSaturation.value = p.saturation;
      particleUniforms.uPixelRatio.value = pixelRatio;
      particleGeometry.setDrawRange(
        0,
        Math.floor(Math.min(particleCount, MAX_PARTICLES) * p.particleDensity),
      );
      linkMaterial.opacity = 0.18 * p.brightness;
    },
    dispose() {
      for (const g of [nodeGeometry, linkGeometry, particleGeometry]) g.dispose();
      for (const m of [nodeMaterial, linkMaterial, particleMaterial]) m.dispose();
    },
  };
}

function BrainContent({
  feed,
  live,
  quality,
  reducedMotion,
  revision,
  tier,
  onTier,
  onReport,
}: Omit<BrainSceneProps, 'onTelemetry'> & {
  tier: QualityTier;
  onTier: (t: QualityTier) => void;
  onReport: (r: FrameReport) => void;
}) {
  const layout = useMemo(() => buildLayout(), []);
  const objects = useMemo(() => makeObjects(layout), [layout]);
  useEffect(() => () => objects.dispose(), [objects]);
  const params = useRef<BrainParams>(IDLE_PARAMS);
  const clocks = useRef<Clocks>({ time: 0, travel: 0, fire: 0 });
  const controller = useMemo(() => new QualityController(quality), [quality]);
  const lastReport = useRef(0);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  // With reduced motion the loop draws on demand: one still frame per change.
  useEffect(() => invalidate(), [revision, reducedMotion, live, invalidate]);

  useFrame((_, delta) => {
    const now = Date.now();
    const f = feed.current;
    const state = brainState({ snapshot: f.snapshot, receivedAt: f.receivedAt, live: liveRef.current, now });
    const target = targetParams(state, f.snapshot);
    const step = Math.min(delta, MAX_STEP_S);
    const p = reducedMotion ? target : smoothParams(params.current, target, step);
    params.current = p;
    const c = clocks.current;
    if (!reducedMotion) {
      c.time += step;
      c.travel += step * p.particleSpeed * FLOW_RATE;
      c.fire += step * p.firingRate;
    }
    const pulses = reducedMotion ? [] : livePulses(f.pulses, now);
    objects.update(p, c, pulses, gl.getPixelRatio(), TIER[tier].particles);

    const next = controller.frame(delta * 1000, performance.now());
    if (next !== tier) onTier(next);
    if (now - lastReport.current >= TELEMETRY_EVERY_MS) {
      lastReport.current = now;
      onReport({ fps: controller.fps, tier: next, frames: controller.frames, state, pulses: pulses.length });
    }
  });

  return <primitive object={objects.group} />;
}

/** The canvas. Remount it (a `key`) to change the quality choice. */
export default function BrainScene({ onTelemetry, ...props }: BrainSceneProps) {
  const [tier, setTier] = useState<QualityTier>(props.quality === 'auto' ? 'high' : props.quality);
  const box = useRef<HTMLDivElement>(null);
  // Frame-time telemetry (NFR-12): on the container for tests and measurements, and to the page.
  const report = useCallback(
    (r: FrameReport) => {
      const el = box.current;
      if (el) {
        el.dataset['fps'] = r.fps === null ? '' : String(Math.round(r.fps));
        el.dataset['frames'] = String(r.frames);
        el.dataset['state'] = r.state;
        el.dataset['pulses'] = String(r.pulses);
        el.dataset['quality'] = r.tier;
      }
      onTelemetry({ fps: r.fps, tier: r.tier, frames: r.frames });
    },
    [onTelemetry],
  );
  return (
    <div
      ref={box}
      className="h-full w-full"
      data-brain-view="3d"
      data-frameloop={props.frameloop}
      data-quality={tier}
      aria-hidden
    >
      <Canvas
        frameloop={props.frameloop}
        dpr={[1, TIER[tier].maxDpr]}
        camera={{ position: [0, 0.2, 2.9], fov: 42, near: 0.1, far: 20 }}
        gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
      >
        <BrainContent {...props} tier={tier} onTier={setTier} onReport={report} />
      </Canvas>
    </div>
  );
}
