<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { simplifyFlowmap, SimplifiedFlowmap, SimplifiedCheckpoint } from '../logic/flowmap-simplifier';
import { PathCalculator } from '../logic/path-calculator';
import { BeetleRankSnapshot } from '../logic/types';
import flowmapJson from '../../flowmap.json';

const canvasRef = ref<HTMLCanvasElement | null>(null);
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let animationId: number;

const selectedZone = ref<string>('all');
const availableZones = ref<string[]>([]);
const flowmap = ref<SimplifiedFlowmap>({});
const sessionCode = ref('');
const isConnected = ref(false);
let ws: WebSocket | null = null;
const racerMarkers = new Map<string, THREE.Mesh>();
const racerTrails = new Map<string, THREE.Line>();
const racerColors = new Map<string, number>();
const racerLabels = new Map<string, any>();
let pathCalculator: PathCalculator | null = null;

onMounted(() => {
  flowmap.value = simplifyFlowmap(flowmapJson);
  availableZones.value = ['all', ...Object.keys(flowmap.value)];

  // Load session code from localStorage
  const stored = localStorage.getItem('sessionCode');
  if (stored) {
    sessionCode.value = stored;
  }

  if (canvasRef.value) {
    initScene();
    pathCalculator = new PathCalculator(flowmap.value);
    renderFlowmap();
    animate();
  }
});

onUnmounted(() => {
  if (animationId) {
    cancelAnimationFrame(animationId);
  }
  if (renderer) {
    renderer.dispose();
  }
  disconnectWebSocket();
});

function initScene() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1014);

  // Camera
  camera = new THREE.PerspectiveCamera(
    75,
    canvasRef.value!.clientWidth / canvasRef.value!.clientHeight,
    0.1,
    10000
  );
  camera.position.set(0, 500, 1000);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value!,
    antialias: true
  });
  renderer.setSize(canvasRef.value!.clientWidth, canvasRef.value!.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(100, 200, 100);
  scene.add(directionalLight);

  // Grid
  const gridHelper = new THREE.GridHelper(2000, 40, 0x444444, 0x222222);
  scene.add(gridHelper);

  // Axes
  const axesHelper = new THREE.AxesHelper(500);
  scene.add(axesHelper);

  // Handle resize
  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  if (!canvasRef.value) return;
  camera.aspect = canvasRef.value.clientWidth / canvasRef.value.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(canvasRef.value.clientWidth, canvasRef.value.clientHeight);
}

function renderFlowmap() {
  // Clear previous checkpoint/path objects (keep grid, axes, racers)
  const objectsToRemove = scene.children.filter(obj =>
    obj.type !== 'GridHelper' &&
    obj.type !== 'AxesHelper' &&
    obj.type !== 'AmbientLight' &&
    obj.type !== 'DirectionalLight' &&
    !obj.userData.racerName && // Don't remove racer markers
    !obj.userData.isRacerTrail && // Don't remove racer trails
    !obj.userData.isLabel // Don't remove racer labels
  );
  objectsToRemove.forEach(obj => scene.remove(obj));

  const zones = selectedZone.value === 'all'
    ? Object.entries(flowmap.value)
    : [[selectedZone.value, flowmap.value[selectedZone.value]]];

  const colors = [
    0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff,
    0xff8800, 0x88ff00, 0x0088ff, 0xff0088, 0x8800ff, 0x00ff88
  ];

  zones.forEach(([zoneName, zone], zoneIndex) => {
    if (!zone || typeof zone === 'string') return;

    const color = colors[zoneIndex % colors.length];

    // Draw checkpoints as spheres
    Object.entries(zone.checkpoints).forEach(([checkpointId, checkpoint]: [string, SimplifiedCheckpoint]) => {
      const geometry = new THREE.SphereGeometry(5, 16, 16);
      const material = new THREE.MeshStandardMaterial({ color });
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.set(checkpoint.x, checkpoint.y, checkpoint.z);
      sphere.userData = { id: checkpointId, zone: zoneName };
      scene.add(sphere);

      // Add colored border for start/end checkpoints
      if (checkpoint.type === 'start') {
        const borderGeometry = new THREE.SphereGeometry(6.5, 16, 16);
        const borderMaterial = new THREE.MeshBasicMaterial({
          color: 0x00ff00,
          transparent: true,
          opacity: 0.5,
          side: THREE.BackSide
        });
        const border = new THREE.Mesh(borderGeometry, borderMaterial);
        border.position.set(checkpoint.x, checkpoint.y, checkpoint.z);
        scene.add(border);
      } else if (checkpoint.type === 'end' || checkpoint.type === 'boss') {
        const borderGeometry = new THREE.SphereGeometry(6.5, 16, 16);
        const borderMaterial = new THREE.MeshBasicMaterial({
          color: 0x9b59b6,
          transparent: true,
          opacity: 0.5,
          side: THREE.BackSide
        });
        const border = new THREE.Mesh(borderGeometry, borderMaterial);
        border.position.set(checkpoint.x, checkpoint.y, checkpoint.z);
        scene.add(border);
      }

      // Draw lines to next checkpoints
      checkpoint.next.forEach((nextId: string) => {
        const nextCheckpoint = getCheckpointFromFlowmap(nextId);
        if (nextCheckpoint) {
          const points = [
            new THREE.Vector3(checkpoint.x, checkpoint.y, checkpoint.z),
            new THREE.Vector3(nextCheckpoint.x, nextCheckpoint.y, nextCheckpoint.z)
          ];
          const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
          const lineMaterial = new THREE.LineBasicMaterial({
            color,
            linewidth: 2,
            opacity: 0.7,
            transparent: true
          });
          const line = new THREE.Line(lineGeometry, lineMaterial);
          scene.add(line);
        }
      });
    });
  });
}

function getCheckpointFromFlowmap(id: string) {
  for (const zone of Object.values(flowmap.value)) {
    if (zone.checkpoints[id]) {
      return zone.checkpoints[id];
    }
  }
  return null;
}

function animate() {
  animationId = requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onZoneChange() {
  renderFlowmap();
}

function connectWebSocket() {
  if (!sessionCode.value) return;

  disconnectWebSocket();

  const wsUrl = `wss://www.beetlerank.com:3002/`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    isConnected.value = true;
    console.log('WebSocket connected for 3D view');
  };

  ws.onmessage = (event) => {
    try {
      const snapshot: BeetleRankSnapshot = JSON.parse(event.data);

      updateRacerPositions(snapshot);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e, event.data);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    isConnected.value = false;
  };

  ws.onclose = () => {
    isConnected.value = false;
    console.log('WebSocket disconnected');
  };
}

function disconnectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected.value = false;
}

function updateRacerPositions(snapshot: BeetleRankSnapshot) {
  if (!snapshot.users || !Array.isArray(snapshot.users)) return;

  let matchedCount = 0;
  snapshot.users.forEach((user) => {
    if (!user || !user.user) return;

    // Filter by session code at user level (case insensitive)
    if (!user.sessionCode ||
        user.sessionCode.toString().toLowerCase() !== sessionCode.value.toLowerCase()) {
      return;
    }

    matchedCount++;
    const x = user.x || 0;
    const y = user.y || 0;
    const z = user.z || 0;
    console.log(`Updating racer: ${user.user} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);

    // Get or create racer marker
    let marker = racerMarkers.get(user.user);
    if (!marker) {
      // Assign a unique color to this racer
      const colorHex = racerColors.get(user.user) || generateRacerColor(user.user);
      racerColors.set(user.user, colorHex);

      const geometry = new THREE.ConeGeometry(8, 20, 8);
      const material = new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.3
      });
      marker = new THREE.Mesh(geometry, material);
      marker.userData = { racerName: user.user };
      scene.add(marker);
      racerMarkers.set(user.user, marker);
      
    }

    // Update position
    marker.position.set(x, y, z);
    marker.rotation.x = Math.PI; // Point cone downward

    // Update trail
    updateRacerTrail(user.user, x, y, z);

    // Update label with progress percentage
    updateRacerLabel(user.user, x, y, z);
  });

  if (matchedCount > 0) {
    console.log(`Updated ${matchedCount} racers for session ${sessionCode.value}`);
  }
}

function updateRacerLabel(racerName: string, x: number, y: number, z: number) {
  const progress = pathCalculator ? pathCalculator.getProgress(x, y, z) : 0;

  // Remove old label if exists
  const oldLabel = racerLabels.get(racerName);
  if (oldLabel) {
    scene.remove(oldLabel);
  }

  // Create text sprite
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;

  canvas.width = 256;
  canvas.height = 128;

  context.fillStyle = 'rgba(0, 0, 0, 0.7)';
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.font = 'Bold 48px Arial';
  context.fillStyle = 'white';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(`${progress.toFixed(1)}%`, 128, 64);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.position.set(x, y + 30, z); // Position above the marker
  sprite.scale.set(20, 10, 1);
  sprite.userData = { racerName, isLabel: true };

  scene.add(sprite);
  racerLabels.set(racerName, sprite);
}

function updateRacerTrail(racerName: string, x: number, y: number, z: number) {
  const MAX_TRAIL_POINTS = 50;
  let trail = racerTrails.get(racerName);

  if (!trail) {
    const colorHex = racerColors.get(racerName) || 0xffffff;
    const points = [new THREE.Vector3(x, y, z)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: colorHex,
      linewidth: 3,
      opacity: 0.6,
      transparent: true
    });
    trail = new THREE.Line(geometry, material);
    trail.userData = { isRacerTrail: true, racerName };
    scene.add(trail);
    racerTrails.set(racerName, trail);
  } else {
    const positions = trail.geometry.attributes.position;
    const currentPoints: THREE.Vector3[] = [];

    // Get existing points
    for (let i = 0; i < positions.count; i++) {
      currentPoints.push(new THREE.Vector3(
        positions.getX(i),
        positions.getY(i),
        positions.getZ(i)
      ));
    }

    // Add new point
    currentPoints.push(new THREE.Vector3(x, y, z));

    // Limit trail length
    if (currentPoints.length > MAX_TRAIL_POINTS) {
      currentPoints.shift();
    }

    // Update geometry
    trail.geometry.dispose();
    trail.geometry = new THREE.BufferGeometry().setFromPoints(currentPoints);
  }
}

function generateRacerColor(name: string): number {
  if (!name || typeof name !== 'string' || name.length === 0) {
    return 0xffffff; // Default white for invalid names
  }

  // Generate consistent color from name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  const s = 70 + (Math.abs(hash) % 30);
  const l = 50 + (Math.abs(hash >> 8) % 20);

  return hslToHex(h, s, l);
}

function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));
  return (r << 16) | (g << 8) | b;
}

function onConnectClick() {
  if (sessionCode.value) {
    localStorage.setItem('sessionCode', sessionCode.value);
    connectWebSocket();
  }
}

watch(sessionCode, (newCode) => {
  if (newCode && isConnected.value) {
    connectWebSocket();
  }
});
</script>

<template>
  <div class="visualizer-container">
    <button class="back-to-leaderboard-btn" @click="$emit('back-to-leaderboard')">
      🏁 Back to Leaderboard
    </button>

    <div class="controls-panel">
      <h2>3D Path Visualizer</h2>

      <div class="control-group">
        <label>Session Code:</label>
        <input
          v-model="sessionCode"
          type="text"
          placeholder="Enter session code"
          @keyup.enter="onConnectClick"
        />
        <button @click="onConnectClick" :disabled="!sessionCode || isConnected">
          {{ isConnected ? '🟢 Connected' : '🔴 Connect' }}
        </button>
      </div>

      <div class="control-group">
        <label>Zone:</label>
        <select v-model="selectedZone" @change="onZoneChange">
          <option v-for="zone in availableZones" :key="zone" :value="zone">
            {{ zone }}
          </option>
        </select>
      </div>

      <div class="info">
        <p>🖱️ Left click + drag: Rotate</p>
        <p>🖱️ Right click + drag: Pan</p>
        <p>🖱️ Scroll: Zoom</p>
        <p>⌨️ Tab: Toggle view</p>
      </div>
    </div>
    <canvas ref="canvasRef" class="three-canvas"></canvas>
  </div>
</template>

<style scoped>
.visualizer-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  background: #0e1014;
  overflow: hidden;
}

.three-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.controls-panel {
  position: absolute;
  top: 20px;
  left: 20px;
  background: rgba(0, 0, 0, 0.8);
  padding: 20px;
  border-radius: 8px;
  color: white;
  z-index: 10;
  min-width: 250px;
}

.controls-panel h2 {
  margin: 0 0 15px 0;
  font-size: 18px;
  color: #ffcc00;
}

.control-group {
  margin-bottom: 15px;
}

.control-group label {
  display: block;
  margin-bottom: 5px;
  font-size: 14px;
  color: #aaa;
}

.control-group input,
.control-group select {
  width: 100%;
  padding: 8px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  color: white;
  font-size: 14px;
  margin-bottom: 8px;
}

.control-group button {
  width: 100%;
  padding: 8px;
  background: #444;
  border: 1px solid #555;
  border-radius: 4px;
  color: white;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.control-group button:hover:not(:disabled) {
  background: #555;
}

.control-group button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.info {
  margin-top: 20px;
  padding-top: 15px;
  border-top: 1px solid #333;
}

.info p {
  margin: 5px 0;
  font-size: 12px;
  color: #888;
}

.back-to-leaderboard-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 1000;
  padding: 12px 24px;
  background: rgba(255, 204, 0, 0.9);
  color: #000;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  transition: all 0.2s;
}

.back-to-leaderboard-btn:hover {
  background: rgba(255, 204, 0, 1);
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
}
</style>
