import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Character, loadClips } from './character.js';
import { Ball, Fx, LABELS } from './effects.js';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const BG = 0x0e1220;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 14, 34);

// Камера смотрит сбоку: персонаж справа лицом влево (+Z), шары прилетают слева.
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(7, 1.9, 3.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 2.6);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 3; controls.maxDistance = 16;
controls.update();

// --- свет и пол ---
scene.add(new THREE.HemisphereLight(0x9db8ff, 0x1a1c2a, 0.75));
const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
key.position.set(4, 7, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 25 });
key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
key.target.position.set(0, 0, 2);
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x6a7bff, 2.2); rim.position.set(-5, 3, -4); scene.add(rim);
const rim2 = new THREE.DirectionalLight(0xff4fd8, 1.2); rim2.position.set(5, 2, -5); scene.add(rim2);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(30, 64),
  new THREE.MeshStandardMaterial({ color: 0x151a2b, roughness: 0.85, metalness: 0.1 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(40, 40, 0x3a4570, 0x232a45);
grid.position.y = 0.002; grid.material.transparent = true; grid.material.opacity = 0.5;
scene.add(grid);

// --- персонаж ---
const character = new Character(scene);
const fx = new Fx(scene);

const $ = (id) => document.getElementById(id);
const loadBar = $('loadBar');
const chips = {};
$('score').append(...LABELS.map((l) => {
  const el = document.createElement('span');
  el.className = 'chip'; el.style.background = l.bg; el.style.color = l.fg;
  chips[l.text] = { el, n: 0 }; el.textContent = `${l.text} 0`;
  return el;
}));
function renderMoves() {
  $('moves').textContent = 'Приёмы: ' + (character.moves.map((m) => m.name).join(' · ') || '—');
}

async function addClipsFrom(src, label) {
  const clips = await loadClips(src);
  if (!clips.length) { console.warn('В файле нет анимаций', label); return; }
  const clip = clips[0];
  const idle = /idle/i.test(label);
  if (idle) { character.setIdle(clip); return; }
  const name = label.replace(/\.fbx$/i, '').replace(/[_-]+/g, ' ').trim();
  character.addMove(clip, name || null);
  renderMoves();
}

async function init() {
  await character.load('assets/models/martelo.fbx', (e) => {
    if (e.total) loadBar.style.width = (e.loaded / e.total * 100).toFixed(0) + '%';
  });
  renderMoves();
  // необязательный список готовых анимаций: assets/anims/manifest.json
  // [{ "file": "idle.fbx" }, { "file": "punch.fbx", "name": "Punch" }]
  try {
    const res = await fetch('assets/anims/manifest.json');
    if (res.ok) {
      for (const it of await res.json()) {
        const clips = await loadClips('assets/anims/' + it.file);
        if (!clips.length) continue;
        if (/idle/i.test(it.role || it.file)) character.setIdle(clips[0]);
        else character.addMove(clips[0], it.name || it.file.replace(/\.fbx$/i, '').replace(/[_-]+/g, ' '));
      }
      renderMoves();
    }
  } catch (e) { console.info('manifest.json не найден или повреждён', e.message); }
  $('loading').classList.add('done');
}

// --- перетаскивание .fbx прямо в окно ---
addEventListener('dragover', (e) => { e.preventDefault(); canvas.classList.add('drop'); });
addEventListener('dragleave', () => canvas.classList.remove('drop'));
addEventListener('drop', async (e) => {
  e.preventDefault(); canvas.classList.remove('drop');
  for (const f of e.dataTransfer.files) {
    if (!/\.fbx$/i.test(f.name)) continue;
    try { await addClipsFrom(await f.arrayBuffer(), f.name); } catch (err) { console.error(err); }
  }
});

// --- игровая логика ---
let time = 0;
const balls = [];
let lastEnd = 0;       // момент, когда персонаж освободится
let nextSpawn = 1.2;
let lastMove = null, labelBag = [];

function nextLabel() {
  if (!labelBag.length) labelBag = LABELS.slice().sort(() => Math.random() - 0.5);
  return labelBag.pop();
}
function pickMove() {
  const pool = character.moves.length > 1 ? character.moves.filter((m) => m !== lastMove) : character.moves;
  return (lastMove = pool[Math.floor(Math.random() * pool.length)]);
}
const rnd = (a, b) => a + Math.random() * (b - a);

function spawn() {
  const move = pickMove();
  const strikeStart = Math.max(time + 2.2, lastEnd + 0.25);
  const hitAt = strikeStart + move.hitTime;
  lastEnd = strikeStart + move.clip.duration - 0.1;
  const start = new THREE.Vector3(rnd(-2.5, 2.5), rnd(0.8, 2.6), rnd(9, 10.5));
  // шар прилетает ровно в точку, где в этот момент окажется кулак/нога
  const end = move.hit.point.clone();
  end.addScaledVector(start.clone().sub(end).normalize(), 0.32 * 0.7);
  const ball = new Ball(nextLabel(), start, end, time, hitAt, move, strikeStart);
  scene.add(ball.mesh);
  balls.push(ball);
}

function step(dt) {
  time += dt;
  if (character.moves.length && balls.length < 2 && time >= nextSpawn) { spawn(); nextSpawn = time + 0.5; }
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (!b.struck && time >= b.strikeStart) { character.play(b.move); b.struck = true; }
    b.update(time, camera);
    if (time >= b.hitAt) {
      fx.shatter(b, b.move.hit.dir);
      const c = chips[b.label.text]; c.n++; c.el.textContent = `${b.label.text} ${c.n}`;
      scene.remove(b.mesh); balls.splice(i, 1);
    }
  }
  character.update(dt);
  fx.update(dt);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 55 : 40;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const timer = new THREE.Timer();
const shakeOff = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  step(dt);
  controls.update();
  shakeOff.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(fx.shake);
  camera.position.add(shakeOff);
  renderer.render(scene, camera);
  camera.position.sub(shakeOff);
}

init().then(frame).catch((e) => { $('loadText').textContent = 'Ошибка загрузки: ' + e.message; console.error(e); });
window.__game = { scene, character, balls, step, fx };
