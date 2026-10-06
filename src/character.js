import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const HEIGHT = 1.8;                  // м, итоговый рост персонажа
const FACING = 0;                    // доп. разворот персонажа в сцене (0 = как в анимации: смотрит вправо, +Z)
const ROOT_MOTION = 1;               // доля движения бёдер по полу (выпады вперёд); 0 = стоять строго на месте
const MIN_REACH = 0.25;              // м, удар должен быть вынесен вперёд от бёдер (по +Z)
const BODY_R = 0.3;                  // м, «толщина» корпуса: шар не должен пролетать сквозь тело
const Y_AXIS = new THREE.Vector3(0, 1, 0);
// Точка контакта: кулак — чуть дальше запястья в сторону костяшек, стопа — носок, голова — центр головы
const EFFECTORS = [
  { name: 'LeftHand', kind: 'hand', tip: 'LeftHandMiddle1', k: 1.3 },
  { name: 'RightHand', kind: 'hand', tip: 'RightHandMiddle1', k: 1.3 },
  { name: 'LeftFoot', kind: 'foot', tip: 'LeftToeBase', k: 1.0 },
  { name: 'RightFoot', kind: 'foot', tip: 'RightToeBase', k: 1.0 },
  { name: 'Head', kind: 'head', up: 0.1 },
];
// откуда (угол от +Z в плане) могут лететь шары: только спереди и сбоку, никогда со спины
const APPROACH = [-20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80].map((d) => d * Math.PI / 180);
const FINGERS = /Thumb|Index|Middle|Ring|Pinky/;
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
    this.effectors = EFFECTORS.map((e) => ({
      ...e, bone: model.getObjectByName('mixamorig' + e.name), tipBone: e.tip && model.getObjectByName('mixamorig' + e.tip),
    })).filter((e) => e.bone);

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
    this.stanceClip = THREE.AnimationUtils.subclip(base, 'stance', 0, 1, 30);
    this.idleAction = this.mixer.clipAction(this.stanceClip);
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.#restoreIdle();
  }

  addMove(clip, name) {
    const yaw0 = this.#yawAtStart(clip);
    let baked = this.#bake(clip, this.stanceYaw === undefined ? 0 : angDiff(this.stanceYaw, yaw0));
    baked = this.#trimDead(baked);     // без «мёртвого» времени в начале и в конце
    const hits = this.#analyze(baked);
    const move = {
      clip: baked, hits, yaw0, duration: baked.duration,
      name: name || (hits[0]?.kind === 'foot' ? 'Kick' : 'Punch'),
    };
    move.cands = this.lastDropped;
    this.moves.push(move);
    this.#restoreIdle();   // анализ сбросил микшер
    return move;
  }

  // ---------- переходы ----------

  // Время плавного перехода между концом `from` (null = стойка) и началом `to`: чем сильнее
  // отличаются позы, тем дольше (но не короче 0.3 с).
  blendBetween(from, to) {
    const a = from ? from.clip : this.stanceClip;
    const d = this.#poseDist(a, from ? a.duration : 0, to ? to.clip : this.stanceClip, 0);
    return THREE.MathUtils.clamp(0.3 + d * 0.011, 0.3, 0.75);
  }

  // Сколько секунд хвоста приёма можно «отдать» под следующий переход, не задев его последний удар.
  tailRoom(move) {
    const last = move.hits.length ? move.hits[move.hits.length - 1].time : 0;
    return Math.max(0.12, move.duration - last - 0.08);
  }

  // Средний угол между позами (по всем костям, кроме пальцев), градусы
  #poseDist(clipA, tA, clipB, tB) {
    const b = new Map(clipB.tracks.filter((t) => t.name.endsWith('.quaternion')).map((t) => [t.name, t]));
    let sum = 0, n = 0;
    for (const t of clipA.tracks) {
      const o = b.get(t.name);
      if (!o || FINGERS.test(t.name)) continue;
      const va = t.createInterpolant().evaluate(tA), vb = o.createInterpolant().evaluate(tB);
      const dot = Math.min(1, Math.abs(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2] + va[3] * vb[3]));
      sum += 2 * Math.acos(dot) * 180 / Math.PI; n++;
    }
    return n ? sum / n : 0;
  }

  // ---------- подготовка клипов ----------

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
        for (let i = 0; i < v.length; i += 4) tmp.fromArray(v, i).premultiply(q).toArray(v, i);
      }
      return t;
    });
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  }

  // Обрезаем «вялые» начало и конец, где тело почти не движется (но оставляем разгон 0.12 с).
  #trimDead(clip) {
    const dur = clip.duration, N = Math.ceil(dur * 60), dt = dur / N;
    const a = this.#pose(clip, 0);
    const prev = this.effectors.map(() => new THREE.Vector3());
    const cur = this.effectors.map(() => new THREE.Vector3());
    const speed = [];
    for (let i = 0; i <= N; i++) {
      this.mixer.setTime(i * dt);
      this.model.updateMatrixWorld(true);
      let sum = 0;
      this.effectors.forEach((e, k) => { this.#contact(e, cur[k]); if (i) sum += cur[k].distanceTo(prev[k]) / dt; prev[k].copy(cur[k]); });
      speed.push(sum);
    }
    a.stop(); this.mixer.stopAllAction();
    const thr = 0.9;   // м/с суммарно по конечностям
    let i0 = speed.findIndex((v, i) => i > 0 && v > thr);
    let i1 = speed.length - 1 - [...speed].reverse().findIndex((v) => v > thr);
    if (i0 < 0) return clip;
    const t0 = Math.max(0, i0 * dt - 0.12), t1 = Math.min(dur, i1 * dt + 0.12);
    if (t0 < 0.15 && dur - t1 < 0.15) return clip;   // нечего резать
    return this.#cut(clip, t0 < 0.15 ? 0 : t0, dur - t1 < 0.15 ? dur : t1);
  }

  #cut(clip, t0, t1) {
    const tracks = clip.tracks.map((tr) => {
      const vs = tr.getValueSize(), itp = tr.createInterpolant();
      const times = [0], values = [...itp.evaluate(t0)];
      for (let i = 0; i < tr.times.length; i++) {
        const t = tr.times[i];
        if (t > t0 + 1e-4 && t < t1 - 1e-4) { times.push(t - t0); for (let k = 0; k < vs; k++) values.push(tr.values[i * vs + k]); }
      }
      times.push(t1 - t0); values.push(...itp.evaluate(t1));
      return new tr.constructor(tr.name, times, values);
    });
    return new THREE.AnimationClip(clip.name, t1 - t0, tracks);
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

  // Мировая позиция точки контакта конечности по имени (для отладки/тестов)
  contactPoint(name, out = new THREE.Vector3()) { return this.#contact(this.effectors.find((e) => e.name === name), out); }

  // Мировая позиция точки контакта конечности
  #contact(e, out) {
    e.bone.getWorldPosition(out);
    if (e.tipBone) {
      const tip = e.tipBone.getWorldPosition(new THREE.Vector3());
      out.lerp(tip, e.k);
    } else if (e.up) {
      out.copy(e.bone.localToWorld(new THREE.Vector3(0, e.up / this.model.scale.x, 0)));
    }
    return out;
  }

  // ---------- проигрывание ----------

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

  // Запускать за `pre` секунд до первого кадра движения (можно во время хвоста предыдущего
  // приёма): поза плавно набирается при замороженном времени, потом клип идёт — и все удары
  // попадают в рассчитанные моменты.
  play(move, pre) {
    const a = this.mixer.clipAction(move.clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.paused = true;
    this.current = { action: a, move };
    this.pending = { action: a, left: pre };
    this.#fadeTo(a, pre);
  }

  #onFinished(action) {
    if (this.current?.action !== action) return;   // следующий приём уже запущен — он сам всё смешает
    const move = this.current.move;
    this.current = null;
    this.#showIdle();
    this.#fadeTo(this.idleAction, this.blendBetween(move, null));
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

  // ---------- поиск ударов ----------

  // Сэмплируем клип и находим удары: быстрые «выбросы» руки / ноги / головы от тела.
  // Для каждого удара подбираем сторону, с которой может прилететь шар: только спереди/сбоку и так,
  // чтобы шар не пролетал сквозь тело; если такой стороны нет — удар отбрасывается.
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
      this.effectors.forEach((e, k) => pos[k].push(this.#contact(e, new THREE.Vector3())));
      hipsPos.push(this.hips.getWorldPosition(new THREE.Vector3()));
    }
    act.stop();
    this.mixer.stopAllAction();

    const W = Math.max(2, Math.round(0.1 / dt));   // окно скорости ±0.1 с
    const PW = Math.max(3, Math.round(0.3 / dt));  // окно пика ±0.3 с
    const anchor = hipsPos[0];
    const cands = [];
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
      // явных ударов нет (например, удар головой на месте): берём момент, когда голова дальше
      // всего ушла от стартовой точки, а если головы нет — самую быструю точку клипа
      let best = null;
      const hk = this.effectors.findIndex((e) => e.kind === 'head');
      if (hk >= 0) {
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

    const hits = [];
    this.lastDropped = [];
    for (const c of picked) {
      const p = pos[c.k], pt = p[c.i], h = hipsPos[c.i];
      const vz = pt.z - p[Math.max(0, c.i - Math.round(0.08 / dt))].z;
      (this.lastDropped ||= []).push(`${this.effectors[c.k].name}@${(c.i * dt).toFixed(2)} reach${(pt.z - h.z).toFixed(2)} vz${vz.toFixed(2)} y${pt.y.toFixed(2)}`);
      if (pt.z - h.z < MIN_REACH) continue;   // замах назад / удар за спиной — шар сюда честно не попадёт
      const approach = this.#pickApproach(pt, h);
      if (!approach) continue;
      const dir = pt.clone().sub(p[Math.max(0, c.i - Math.round(0.08 / dt))]);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      hits.push({
        // шар касается в момент, когда конечность уже почти в крайней точке
        time: Math.max(0, c.i * dt - 0.015),
        point: pt.clone(), dir: dir.normalize(), approach,
        kind: this.effectors[c.k].kind, effector: this.effectors[c.k].name,
      });
    }
    return hits;
  }

  // Выбираем направление подлёта в плане (единичный вектор от точки удара наружу):
  // ближе всего к «наружу от тела», только из передней полусферы и без пересечения корпуса.
  #pickApproach(pt, hips) {
    const out = new THREE.Vector3(pt.x - hips.x, 0, pt.z - hips.z);
    const outAng = out.lengthSq() < 1e-4 ? 0 : Math.atan2(out.x, out.z);
    let best = null;
    for (const th of APPROACH) {
      const dx = Math.sin(th), dz = Math.cos(th);
      let ok = true;
      for (let s = 0.25; s <= 3 && ok; s += 0.1) {
        const x = pt.x + dx * s - hips.x, z = pt.z + dz * s - hips.z;
        if (x * x + z * z < BODY_R * BODY_R) ok = false;
      }
      if (!ok) continue;
      const diff = Math.abs(angDiffRad(th, outAng));
      if (!best || diff < best.diff) best = { th, diff };
    }
    return best ? new THREE.Vector3(Math.sin(best.th), 0, Math.cos(best.th)) : null;
  }
}

function angDiff(a, b) { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }
function angDiffRad(a, b) { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; }

// Клипы из .fbx (ArrayBuffer) — для перетаскивания новых анимаций в окно
export async function loadFbxClips(buffer) {
  return new FBXLoader().parse(buffer, '').animations;
}
