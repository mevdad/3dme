import * as THREE from 'three';

export const LABELS = [
  { text: 'JS',     bg: '#f7df1e', fg: '#1d1d1d' },
  { text: 'PHP',    bg: '#7a86b8', fg: '#ffffff' },
  { text: 'Python', bg: '#3776ab', fg: '#ffd43b' },
  { text: 'CSS',    bg: '#2965f1', fg: '#ffffff' },
  { text: 'Web3',   bg: '#f6851b', fg: '#ffffff' },
  { text: 'AI',     bg: '#b052ff', fg: '#ffffff' },
];

const RADIUS = 0.32;
const ballGeo = new THREE.SphereGeometry(RADIUS, 40, 28);
const shardGeo = new THREE.TetrahedronGeometry(1, 0);
const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
const up = new THREE.Vector3(0, 1, 0);

function ballTexture(l) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  // +Z сферы three.js смотрит в u = 0.25 → рисуем надпись на x = 256
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, l.bg); grd.addColorStop(1, shade(l.bg, -0.35));
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 512);
  const size = l.text.length <= 2 ? 190 : l.text.length <= 4 ? 140 : 108;
  g.font = `800 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = l.fg;
  g.fillText(l.text, 256, 262);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function shade(hex, f) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, f);
  return '#' + c.getHexString();
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,.9)'); grd.addColorStop(.35, 'rgba(255,255,255,.25)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const glowTex = glowTexture();

function textSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = '800 72px system-ui, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,.55)'; g.strokeText(text, 256, 64);
  g.fillStyle = color; g.fillText(text, 256, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
}

// Материалы на каждую метку делаем один раз
const cache = new Map();
function assets(l) {
  if (!cache.has(l.text)) {
    const map = ballTexture(l);
    cache.set(l.text, {
      ball: new THREE.MeshStandardMaterial({ map, roughness: 0.32, metalness: 0.05, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.35 }),
      shard: new THREE.MeshStandardMaterial({ color: l.bg, roughness: 0.4, emissive: l.bg, emissiveIntensity: 0.4, flatShading: true }),
      glow: new THREE.SpriteMaterial({ map: glowTex, color: l.bg, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    });
  }
  return cache.get(l.text);
}

// Летящий шар. Траектория полностью детерминирована: из start в end за [t0, hitAt].
export class Ball {
  constructor(label, start, end, t0, hitAt, move, strikeStart) {
    this.label = label; this.start = start; this.end = end;
    this.t0 = t0; this.hitAt = hitAt; this.move = move; this.strikeStart = strikeStart;
    this.struck = false;
    const a = assets(label);
    this.mesh = new THREE.Group();
    this.body = new THREE.Mesh(ballGeo, a.ball);
    this.body.castShadow = true;
    this.glow = new THREE.Sprite(a.glow);
    this.glow.scale.setScalar(RADIUS * 5);
    this.mesh.add(this.body, this.glow);
    this.mesh.position.copy(start);
  }

  update(now, camera) {
    const k = THREE.MathUtils.clamp((now - this.t0) / (this.hitAt - this.t0), 0, 1);
    this.mesh.position.lerpVectors(this.start, this.end, k);
    this.mesh.position.y += Math.sin(k * Math.PI) * 0.35; // лёгкая дуга, в конце = 0
    this.body.lookAt(camera.position);          // надпись всегда читается
    this.body.rotateZ(Math.sin(now * 2 + this.t0) * 0.25);
  }
}

// Осколки, ударная волна и всплывающая надпись
export class Fx {
  constructor(scene) {
    this.scene = scene;
    this.shards = [];
    this.rings = [];
    this.pops = [];
    this.shake = 0;
  }

  shatter(ball, dir) {
    const a = assets(ball.label);
    const origin = ball.mesh.position.clone();
    for (let i = 0; i < 34; i++) {
      const m = new THREE.Mesh(shardGeo, a.shard);
      const s = RADIUS * (0.18 + Math.random() * 0.32);
      const sy = 0.5 + Math.random();
      m.scale.set(s, s * sy, s);
      m.position.copy(origin).addScaledVector(new THREE.Vector3().randomDirection(), RADIUS * 0.5);
      m.castShadow = true;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(2.2)
        .addScaledVector(dir, 3.5 + Math.random() * 6).add(new THREE.Vector3(0, 1.8, 0));
      this.shards.push({
        m, v, base: s, sy, life: 1.3 + Math.random() * 0.9, age: 0,
        spin: new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 10),
      });
      this.scene.add(m);
    }
    // ударная волна
    const rm = new THREE.MeshBasicMaterial({ color: ball.label.bg, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const ring = new THREE.Mesh(ringGeo, rm);
    ring.position.copy(origin);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().lengthSq() ? dir.clone().normalize() : up);
    this.scene.add(ring);
    this.rings.push({ m: ring, age: 0 });
    // вспышка
    const flash = new THREE.Sprite(a.glow.clone());
    flash.position.copy(origin); flash.scale.setScalar(0.1);
    flash.material.color.set('#ffffff');
    this.scene.add(flash);
    this.rings.push({ m: flash, age: 0, flash: true });
    // «+1 JS»
    const t = textSprite('+1 ' + ball.label.text, ball.label.bg);
    t.position.copy(origin).add(new THREE.Vector3(0, 0.5, 0));
    t.scale.set(2, 0.5, 1);
    t.renderOrder = 10;
    this.scene.add(t);
    this.pops.push({ m: t, age: 0 });
    this.shake = Math.min(0.07, this.shake + 0.045);
  }

  update(dt) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.age += dt;
      s.v.y -= 9.8 * dt;
      s.m.position.addScaledVector(s.v, dt);
      if (s.m.position.y < 0.03) {            // пол
        s.m.position.y = 0.03;
        s.v.y *= -0.35; s.v.x *= 0.7; s.v.z *= 0.7;
        s.spin.multiplyScalar(0.6);
      }
      s.m.rotation.x += s.spin.x * dt; s.m.rotation.y += s.spin.y * dt; s.m.rotation.z += s.spin.z * dt;
      const fade = THREE.MathUtils.clamp((s.life - s.age) / 0.45, 0, 1);
      s.m.scale.set(s.base * fade, s.base * fade * s.sy, s.base * fade); // уменьшаем перед исчезновением
      if (s.age >= s.life) { this.scene.remove(s.m); this.shards.splice(i, 1); }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      const k = r.age / (r.flash ? 0.22 : 0.5);
      if (r.flash) { r.m.scale.setScalar(0.1 + k * 1.6); r.m.material.opacity = 1 - k; }
      else { r.m.scale.setScalar(0.2 + k * 1.5); r.m.material.opacity = 0.9 * (1 - k); }
      if (k >= 1) {
        this.scene.remove(r.m); r.m.material.dispose(); this.rings.splice(i, 1);
      }
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.age += dt;
      p.m.position.y += dt * 0.8;
      p.m.material.opacity = 1 - THREE.MathUtils.smoothstep(p.age, 0.5, 1.1);
      if (p.age > 1.1) { this.scene.remove(p.m); p.m.material.map.dispose(); p.m.material.dispose(); this.pops.splice(i, 1); }
    }
    this.shake *= Math.exp(-dt * 9);
  }
}
