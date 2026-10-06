import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Character, loadFbxClips } from './character.js';
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

// Камера смотрит сбоку: персонаж слева лицом вправо (+Z), шары прилетают справа.
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(-7, 1.9, 3.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 2.6);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 3; controls.maxDistance = 16;
controls.update();

// --- свет и пол ---
scene.add(new THREE.HemisphereLight(0x9db8ff, 0x1a1c2a, 0.75));
const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
key.position.set(-4, 7, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 25 });
key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
key.target.position.set(0, 0, 2);
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x6a7bff, 2.2); rim.position.set(5, 3, -4); scene.add(rim);
const rim2 = new THREE.DirectionalLight(0xff4fd8, 1.2); rim2.position.set(-5, 2, -5); scene.add(rim2);

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

// Порядок серии: сначала Fist Fight (его первый кадр = боевая стойка), Headbutt в конце —
// он заканчивается в позе, самой близкой к стойке, поэтому возврат в неё почти незаметен.
const ORDER = ['Fist Fight', 'Jab & Kick', 'Chapa Giratoria', 'Headbutt'];
const prettify = (f) => f.replace(/\.fbx$/i, '').replace(/[_-]+/g, ' ').trim();

async function init() {
  const clips = await character.load('assets/models/martelo.glb', (e) => {
    if (e.total) loadBar.style.width = (e.loaded / e.total * 100).toFixed(0) + '%';
  });
  const rank = (n) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };
  clips.sort((a, b) => rank(a.name) - rank(b.name));
  if (clips.length) {
    character.setStance(clips[0]);
    for (const c of clips) character.addMove(c, c.name);
  }
  renderMoves();
  $('loading').classList.add('done');
}

// --- перетаскивание .fbx прямо в окно ---
addEventListener('dragover', (e) => { e.preventDefault(); canvas.classList.add('drop'); });
addEventListener('dragleave', () => canvas.classList.remove('drop'));
addEventListener('drop', async (e) => {
  e.preventDefault(); canvas.classList.remove('drop');
  for (const f of e.dataTransfer.files) {
    if (!/\.fbx$/i.test(f.name)) continue;
    try {
      const [clip] = await loadFbxClips(await f.arrayBuffer());
      if (clip) { character.addMove(clip, prettify(f.name)); renderMoves(); }
    } catch (err) { console.error(err); }
  }
});

// --- игровая логика ---
// Приёмы идут по кругу (раунд = все приёмы по одному разу). Между приёмами и после раунда
// персонаж возвращается в боевую стойку и ждёт.
const TRAVEL = 2.0;     // с, сколько летит шар до удара
const REST = 3.0;       // с, пауза в стойке после раунда
let time = 0;
const balls = [];
const schedule = [];    // { playAt, move }
let lastEnd = 0;        // момент, когда текущий приём закончится
let moveIdx = 0, round = 1, labelBag = [];
let stopLeft = 0, lastStop = -1;   // «hit-stop»: на долю секунды всё замедляется в момент удара
let prevMove = null;    // последний запланированный приём (null = персонаж в стойке)

function nextLabel() {
  if (!labelBag.length) labelBag = LABELS.slice().sort(() => Math.random() - 0.5);
  return labelBag.pop();
}
const rnd = (a, b) => a + Math.random() * (b - a);

function toast(text) {
  const el = $('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

function spawnMove() {
  // приёмы без достижимых ударов (все удары «за спиной») пропускаем
  const playable = character.moves.filter((m) => m.hits.length);
  const move = playable[moveIdx % playable.length];
  const first = move.hits[0].time;
  // плавность перехода зависит от того, насколько отличаются конец предыдущего приёма и начало этого;
  // перекрываем хвост предыдущего, не задевая его последний удар, а недостающее — добавляем паузой
  const pre = character.blendBetween(prevMove, move);
  const overlap = prevMove ? Math.min(pre, character.tailRoom(prevMove)) : pre;
  const strikeStart = Math.max(time + Math.max(pre, TRAVEL - first) + 0.1, lastEnd + (pre - overlap));
  lastEnd = strikeStart + move.duration;
  prevMove = move;
  schedule.push({ playAt: strikeStart - pre, move, pre });
  for (const h of move.hits) {
    const hitAt = strikeStart + h.time;
    // шар прилетает точно туда, где в этот момент окажется кулак/нога/голова — спереди или сбоку
    const jitter = THREE.MathUtils.clamp(rnd(-0.25, 0.25), -0.25, 0.25);
    const dirA = h.approach.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), jitter);
    if (dirA.z < 0.17) dirA.copy(h.approach);   // не разворачиваем в сторону тела
    const end = h.point.clone().addScaledVector(dirA, 0.32 * 0.85);
    const start = h.point.clone().addScaledVector(dirA, rnd(8, 9.5));
    start.y = Math.max(0.5, h.point.y + rnd(-0.2, 1.2));
    const ball = new Ball(nextLabel(), start, end, hitAt - TRAVEL, hitAt, h.dir);
    ball.hit = h; ball.moveName = move.name;
    scene.add(ball.mesh);
    balls.push(ball);
  }
  if (++moveIdx >= playable.length) {
    moveIdx = 0;
    const r = round++;
    schedule.push({ at: lastEnd, fn: () => toast(`Раунд ${r} пройден — стойка`) });
    lastEnd += REST;
    prevMove = null;   // после паузы персонаж стоит в стойке
  }
}

function step(dt) {
  time += dt;
  if (character.moves.length && lastEnd - time < 2.0) spawnMove();
  for (let i = schedule.length - 1; i >= 0; i--) {
    const s = schedule[i];
    if (time >= (s.playAt ?? s.at)) { s.move ? character.play(s.move, s.pre) : s.fn(); schedule.splice(i, 1); }
  }
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.update(time, camera);
    if (time >= b.hitAt) {
      fx.shatter(b, b.dir);
      if (time - lastStop > 0.35) { stopLeft = 0.06; lastStop = time; }
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
const debug = { frozen: false };  // для автотестов/скриншотов
const shakeOff = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  if (!debug.frozen) {
    const slow = stopLeft > 0;
    if (slow) stopLeft -= dt;
    step(slow ? dt * 0.12 : dt);   // весь мир (персонаж, шары, осколки) замедляется синхронно
  }
  controls.update();
  shakeOff.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(fx.shake);
  camera.position.add(shakeOff);
  renderer.render(scene, camera);
  camera.position.sub(shakeOff);
}

init().then(frame).catch((e) => { $('loadText').textContent = 'Ошибка загрузки: ' + e.message; console.error(e); });
window.__game = { debug, scene, character, balls, step, fx, schedule, get time() { return time; } };
