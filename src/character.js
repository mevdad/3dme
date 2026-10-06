import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const HEIGHT = 1.8;                  // м, итоговый рост персонажа
const FACING = 0;                     // доп. разворот персонажа в сцене (0 = как в анимации: смотрит вправо, +Z)
const ROOT_MOTION = 1;               // доля движения бёдер по полу (выпады вперёд); 0 = стоять строго на месте
const BLEND = 0.45;                  // с, кроссфейд между приёмами и стойкой
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const EFFECTORS = [
  { name: 'LeftHand', kind: 'hand' }, { name: 'RightHand', kind: 'hand' },
  { name: 'LeftFoot', kind: 'foot' }, { name: 'RightFoot', kind: 'foot' },
  { name: 'Head', kind: 'head' },
];
const smooth = (k) => k * k * k * (k * (k * 6 - 15) + 10);   // smootherstep: мягкий вход и выход

// Персонаж на Mixamo-скелете: боевая стойка + приёмы.
// Персонаж возвращается в одну и ту же точку после каждого приёма; стартовый разворот каждого
// клипа подогнан под стойку — переходы без «проворотов».
export class Character {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.rotation.y = FACING;
    scene.add(this.root);
    this.moves = [];
    this.idleAction = null;
    this.current = null;     // { action, move }
    this.pending = null;     // приём, у которого поза уже набирается, а время ещё стоит на 0
    this.live = new Set();   // actions с ненулевым весом
    this.xf = null;          // текущий кроссфейд
    this.t = 0;
  }

  // Загружает модель (.glb) вместе с клипами; возвращает список клипов.
  async load(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, onProgress);
    const model = this.model = gltf.scene;
    this.root.add(model);
    model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
      if (o.isSkinnedMesh) this.skinned = o;
    });
    this.mixer = new THREE.AnimationMixer(model);
    this.mixer.addEventListener('finished', (e) => this.#onFinished(e.action));
    this.hips = model.getObjectByName('mixamorigHips');
    this.effectors = EFFECTORS.map((e) => ({ ...e, bone: model.getObjectByName('mixamorig' + e.name) }))
      .filter((e) => e.bone);

    // масштаб по росту в bind-позе
    model.updateMatrixWorld(true);
    const bind = new THREE.Box3().setFromObject(this.skinned, true);
    model.scale.setScalar(HEIGHT / bind.getSize(new THREE.Vector3()).y);
    this.baseScaleY = model.scale.y;
    return gltf.animations;
  }

  // Боевая стойка = первый кадр этого клипа. Стойка — «якорь»: все приёмы разворачиваются
  // так, чтобы начинать с того же направления тела, и возвращаются в неё.
  setStance(clip) {
    const base = this.#bake(clip, 0);
    this.stanceYaw = this.#yawAtStart(base);
    this.#ground(base);
    // отдельный клип из одного кадра: нельзя делить action с самим приёмом (у Fist Fight
    // стойка совпадает с его началом) — у них разные режимы цикла и веса.
    this.idleAction = this.mixer.clipAction(THREE.AnimationUtils.subclip(base, 'stance', 0, 1, 30));
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.#restoreIdle();
  }

  addMove(clip, name) {
    const yaw0 = this.#yawAtStart(clip);
    const baked = this.#bake(clip, this.stanceYaw === undefined ? 0 : angDiff(this.stanceYaw, yaw0));
    const hits = this.#analyze(baked);
    const move = {
      clip: baked, hits, yaw0, duration: baked.duration, pre: BLEND, post: BLEND,
      name: name || (hits[0]?.kind === 'foot' ? 'Kick' : 'Punch'),
    };
    move.peaks = this.lastPeaks;
    this.moves.push(move);
    this.#restoreIdle();   // анализ сбросил микшер
    return move;
  }

  // Копия клипа: поворот тела на yawDeg (+ масштаб выпадов по полу, см. ROOT_MOTION).
  #bake(clip, yawDeg) {
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yawDeg * Math.PI / 180);
    const tmp = new THREE.Quaternion();
    const tracks = clip.tracks.map((t) => {
      t = t.clone();
      if (t.name === 'mixamorigHips.position') {
        // смещение бёдер по полу (выпады) — масштабируем и поворачиваем вместе с телом; клипы
        // возвращаются в исходную точку, поэтому между приёмами персонаж стоит на месте
        const v = t.values, d = new THREE.Vector3();
        for (let i = 3; i < v.length; i += 3) {
          d.set(v[i] - v[0], 0, v[i + 2] - v[2]).multiplyScalar(ROOT_MOTION).applyQuaternion(q);
          v[i] = v[0] + d.x; v[i + 2] = v[2] + d.z;
        }
      } else if (t.name === 'mixamorigHips.quaternion' && yawDeg) {
        const v = t.values;
        for (let i = 0; i < v.length; i += 4) {
          tmp.fromArray(v, i).premultiply(q).toArray(v, i);
        }
      }
      return t;
    });
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  }

  #pose(clip, time) {
    this.#clearAll();
    const a = this.mixer.clipAction(clip).play();
    this.mixer.setTime(time);
    this.model.updateMatrixWorld(true);
    return a;
  }

  #yawAtStart(clip) {
    const a = this.#pose(clip, 0);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.hips.getWorldQuaternion(new THREE.Quaternion()));
    a.stop();
    this.mixer.stopAllAction();
    return Math.atan2(f.x, f.z) * 180 / Math.PI;
  }

  // ставим ступни на пол по позе первого кадра
  #ground(clip) {
    const a = this.#pose(clip, 0);
    const box = new THREE.Box3().setFromObject(this.skinned, true);
    this.model.position.y -= box.min.y;
    a.stop();
    this.mixer.stopAllAction();
  }

  #clearAll() { this.mixer.stopAllAction(); this.live.clear(); this.xf = null; }

  #restoreIdle() {
    this.#clearAll();
    this.current = null; this.pending = null;
    if (!this.idleAction) return;
    this.#showIdle();
    this.idleAction.setEffectiveWeight(1);
  }

  #showIdle() {
    const a = this.idleAction;
    a.reset();
    a.paused = true;       // стойка — замороженный кадр
    a.setEffectiveWeight(0);
    a.play();
    this.live.add(a);
  }

  // Плавно (smootherstep) уводим вес всех живых actions в `to`. Сумма весов всегда = 1,
  // поэтому поза не «проваливается» в bind-позу посреди перехода.
  #fadeTo(to, dur) {
    const from = [...this.live].filter((a) => a !== to).map((a) => ({ a, w0: a.getEffectiveWeight() }));
    to.setEffectiveWeight(0);
    to.play();
    this.live.add(to);
    this.xf = { to, from, t: 0, dur };
  }

  // Запускать за move.pre секунд до первого кадра движения (можно во время хвоста предыдущего
  // приёма): поза плавно набирается при замороженном времени, потом клип идёт — и все удары
  // попадают в рассчитанные моменты.
  play(move) {
    const a = this.mixer.clipAction(move.clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.paused = true;
    this.current = { action: a, move };
    this.pending = { action: a, left: move.pre };
    this.#fadeTo(a, move.pre);
  }

  #onFinished(action) {
    if (this.current?.action !== action) return;   // следующий приём уже запущен — он сам всё смешает
    const post = this.current.move.post;
    this.current = null;
    this.#showIdle();
    this.#fadeTo(this.idleAction, post);
  }

  update(dt) {
    this.t += dt;
    if (this.pending) {
      this.pending.left -= dt;
      if (this.pending.left <= 0) { this.pending.action.paused = false; this.pending = null; }
    }
    const x = this.xf;
    if (x) {
      x.t += dt;
      const k = Math.min(1, x.t / x.dur), s = smooth(k);
      x.to.setEffectiveWeight(s);
      for (const f of x.from) f.a.setEffectiveWeight(f.w0 * (1 - s));
      if (k >= 1) {
        for (const f of x.from) { f.a.stop(); this.live.delete(f.a); }
        this.xf = null;
      }
    }
    this.mixer?.update(dt);
    if (this.model) this.model.scale.y = this.baseScaleY * (1 + 0.005 * Math.sin(this.t * 2.2)); // дыхание
  }

  // Сэмплируем клип и находим удары: быстрые «выбросы» руки / ноги / головы от тела.
  #analyze(clip) {
    const dur = clip.duration;
    const N = Math.max(8, Math.ceil(dur * 60));
    const dt = dur / N;
    const act = this.#pose(clip, 0);
    const pos = this.effectors.map(() => []);
    const hipsPos = [];
    for (let i = 0; i <= N; i++) {
      this.mixer.setTime(i * dt);
      this.model.updateMatrixWorld(true);
      this.effectors.forEach((e, k) => pos[k].push(e.bone.getWorldPosition(new THREE.Vector3())));
      hipsPos.push(this.hips.getWorldPosition(new THREE.Vector3()));
    }
    act.stop();
    this.mixer.stopAllAction();

    const W = Math.max(2, Math.round(0.1 / dt));   // окно скорости ±0.1 с
    const PW = Math.max(3, Math.round(0.3 / dt));  // окно пика ±0.3 с
    const anchor = hipsPos[0];
    const cands = [];
    const peaks = this.lastPeaks = [];   // для отладки порогов
    this.effectors.forEach((e, k) => {
      const p = pos[k];
      const r = p.map((v) => v.distanceTo(anchor));     // удаление от стартовой точки тела
      for (let i = W; i <= N - W; i++) {
        let top = true;
        for (let d = -PW; d <= PW && top; d++) { const j = i + d; if (j >= 0 && j <= N && r[j] > r[i] + 1e-9) top = false; }
        if (!top) continue;
        let mn = Infinity;
        for (let j = Math.max(0, i - PW); j <= i; j++) mn = Math.min(mn, r[j]);
        const prom = r[i] - mn;                           // насколько «выбросило» от тела
        let vmax = 0;
        for (let j = Math.max(1, i - PW); j <= i; j++) vmax = Math.max(vmax, p[j].distanceTo(p[j - 1]) / dt);
        if (prom >= 0.12) peaks.push({ t: +(i * dt).toFixed(2), e: e.name, prom: +prom.toFixed(2), v: +vmax.toFixed(1), y: +p[i].y.toFixed(2) });
        if (e.kind === 'foot' && p[i].y < 0.3) continue;  // шаг, а не удар
        if (e.kind === 'head' && p[i].y < 1.0) continue;
        if (!((prom >= 0.2 && vmax >= 2.4) || (prom >= 0.15 && vmax >= 6))) continue;
        cands.push({ i, k, prom, vmax, score: vmax * (1 + prom) * (e.kind === 'foot' ? 1.3 : 1) });
      }
    });
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of cands) if (picked.every((p) => Math.abs(p.i - c.i) * dt >= 0.12)) picked.push(c);
    if (!picked.length) {
      // явных ударов нет (например, удар головой на месте): берём самый заметный «кивок» головы,
      // а если и его нет — самую быструю точку клипа
      let best = null;
      const hk = this.effectors.findIndex((e) => e.kind === 'head');
      if (hk >= 0) {   // момент, когда голова дальше всего ушла от стартовой точки
        for (let i = 1; i < N; i++) {
          const r = pos[hk][i].distanceTo(anchor);
          if (pos[hk][i].y >= 1.0 && (!best || r > best.v)) best = { i, k: hk, v: r };
        }
      }
      if (!best) {
        this.effectors.forEach((e, k) => {
          for (let i = 1; i < N; i++) {
            const v = pos[k][i - 1].distanceTo(pos[k][i + 1]);
            if (!best || v > best.v) best = { i, k, v };
          }
        });
      }
      picked.push(best);
    }
    picked.sort((a, b) => a.i - b.i);
    return picked.map((c) => {
      const p = pos[c.k];
      const dir = p[c.i].clone().sub(p[Math.max(0, c.i - Math.round(0.08 / dt))]);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      // шар прилетает навстречу движению кулака/ноги; если движение почти вертикальное — со стороны от тела
      const out = dir.clone(); out.y = 0;
      if (out.lengthSq() < 0.09 * dir.lengthSq()) { out.copy(p[c.i]).sub(hipsPos[c.i]); out.y = 0; }
      if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
      // точки считаем в мировых координатах с учётом разворота персонажа в сцене
      return {
        time: c.i * dt,
        point: p[c.i].clone(),
        dir: dir.normalize(),
        out: out.normalize(),
        kind: this.effectors[c.k].kind, effector: this.effectors[c.k].name,
      };
    });
  }
}

function angDiff(a, b) { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

// Клипы из .fbx (ArrayBuffer) — для перетаскивания новых анимаций в окно
export async function loadFbxClips(buffer) {
  return new FBXLoader().parse(buffer, '').animations;
}
