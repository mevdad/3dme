import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const HEIGHT = 1.8;        // м, итоговый рост персонажа
const FADE = 0.12;
const FACING = 40 * Math.PI / 180;  // общий разворот сцены: стойка смотрит влево и чуть к камере
const BLEND = 0.35;       // с, кроссфейд между приёмами и стойкой
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const EFFECTORS = [
  { name: 'LeftHand', kind: 'hand' }, { name: 'RightHand', kind: 'hand' },
  { name: 'LeftFoot', kind: 'foot' }, { name: 'RightFoot', kind: 'foot' },
  { name: 'Head', kind: 'head' },
];

// Персонаж на Mixamo-скелете: стойка в покое + приёмы.
// Приём может содержать несколько ударов — они находятся автоматически (см. #analyze).
export class Character {
  constructor(scene) {
    this.root = new THREE.Group();
    scene.add(this.root);
    this.moves = [];
    this.idleAction = null;
    this.current = null;     // { action, move }
    this.pending = null;     // приём, который «разогревается» (поза уже набирается, но время стоит)
    this.t = 0;
  }

  async load(url, onProgress) {
    const fbx = await new FBXLoader().loadAsync(url, onProgress);
    this.model = fbx;
    this.root.add(fbx);
    fbx.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
      if (o.isSkinnedMesh) this.skinned = o;
    });
    this.mixer = new THREE.AnimationMixer(fbx);
    this.mixer.addEventListener('finished', (e) => this.#onFinished(e.action));
    this.hips = fbx.getObjectByName('mixamorigHips');
    this.effectors = EFFECTORS.map((e) => ({ ...e, bone: fbx.getObjectByName('mixamorig' + e.name) }))
      .filter((e) => e.bone);

    // масштаб по росту в bind-позе
    fbx.updateMatrixWorld(true);
    const bind = new THREE.Box3().setFromObject(this.skinned, true);
    fbx.scale.setScalar(HEIGHT / bind.getSize(new THREE.Vector3()).y);
    this.baseScaleY = fbx.scale.y;

    const clip = fbx.animations[0] || null;
    if (clip) this.#ground(clip);
    return clip;   // клип, вшитый в модель (дальше решает вызывающий код)
  }

  // Боевая стойка = первый кадр этого клипа. Все приёмы разворачиваются так, чтобы их
  // стартовая поза смотрела туда же, — тогда переходы между приёмами бесшовные.
  setStance(clip) {
    this.idleYaw = undefined;
    this.idleYaw = this.#analyze(clip).yaw0;
    // Отдельный клип из первого кадра: нельзя делить action с самим приёмом (у Fist Fight стойка
    // совпадает с его началом) — у них разные режимы зацикливания и веса.
    const pose = THREE.AnimationUtils.subclip(clip, 'stance', 0, 1, 30);
    this.idleAction = this.mixer.clipAction(pose);
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.idleLooped = false;
    this.#restoreIdle();
  }

  // ставим ступни на пол по позе первого кадра анимации
  #ground(clip) {
    const a = this.mixer.clipAction(clip).play();
    this.mixer.setTime(0);
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.skinned, true);
    this.model.position.y -= box.min.y;
    a.stop();
    this.mixer.stopAllAction();
  }

  addMove(clip, name) {
    const a = this.#analyze(clip);
    const move = {
      clip, hits: a.hits, yaw0: a.yaw0, yawOff: a.yawOff, duration: clip.duration,
      pre: BLEND, post: BLEND,
      name: name || (a.hits[0]?.kind === 'foot' ? 'Kick' : 'Punch'),
    };
    this.moves.push(move);
    this.#restoreIdle();  // анализ сбросил микшер
    return move;
  }

  #restoreIdle() {
    if (!this.idleAction) return;
    this.#startIdle(0);
    this.current = null; this.pending = null; this.yawAnim = null;
    this.root.rotation.y = FACING;
  }

  // Другая стойка в покое (клип зацикливается)
  setIdle(clip) {
    this.idleAction?.fadeOut(FADE);
    this.idleAction = this.mixer.clipAction(clip);
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.idleLooped = true;
    this.#startIdle(FADE);
  }

  #startIdle(fade) {
    const a = this.idleAction;
    a.reset();
    a.paused = !this.idleLooped;   // без отдельного idle-клипа держим стойку замороженной
    if (fade) a.fadeIn(fade); else a.setEffectiveWeight(1);
    a.play();
  }

  // Запускать за move.pre секунд до первого кадра движения (можно прямо во время хвоста
  // предыдущего приёма): поза плавно набирается, время клипа стоит на 0, а потом идёт —
  // и все удары попадают в рассчитанные моменты.
  play(move) {
    const pre = move.pre;
    this.idleAction?.fadeOut(pre);
    if (this.current) this.current.action.fadeOut(pre);
    const a = this.mixer.clipAction(move.clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.paused = true;
    a.fadeIn(pre).play();
    this.current = { action: a, move };
    this.pending = { action: a, left: pre };
    this.#turnTo(move.yawOff, pre);
  }

  // поворот корня плавно и линейно, синхронно с весами кроссфейда — разворот поз не «рвётся»
  #turnTo(yaw, dur) { this.yawAnim = { from: this.root.rotation.y, to: yaw, t: 0, dur }; }

  #onFinished(action) {
    if (this.current?.action !== action) return;   // уже запущен следующий приём — он сам всё смешает
    const post = this.current.move.post;
    action.fadeOut(post);
    this.#startIdle(post);
    this.#turnTo(FACING, post);
    this.current = null;
  }

  update(dt) {
    this.t += dt;
    if (this.pending) {
      this.pending.left -= dt;
      if (this.pending.left <= 0) { this.pending.action.paused = false; this.pending = null; }
    }
    const y = this.yawAnim;
    if (y) {
      y.t += dt;
      const k = Math.min(1, y.t / y.dur);
      this.root.rotation.y = y.from + (y.to - y.from) * k;
      if (k >= 1) this.yawAnim = null;
    }
    this.mixer?.update(dt);
    if (this.model) this.model.scale.y = this.baseScaleY * (1 + 0.005 * Math.sin(this.t * 2.2)); // дыхание
  }

  // Сэмплируем клип и находим удары: быстрые «выбросы» руки/ноги/головы от тела.
  #analyze(clip) {
    const dur = clip.duration;
    const N = Math.max(8, Math.ceil(dur * 60));
    const dt = dur / N;
    this.mixer.stopAllAction();                    // иначе стойка подмешается в анализируемую позу
    const act = this.mixer.clipAction(clip).play();
    const pos = this.effectors.map(() => []);
    const hipsPos = [];
    let yaw0 = 0;
    const tmp = new THREE.Vector3(), q = new THREE.Quaternion();
    for (let i = 0; i <= N; i++) {
      this.mixer.setTime(i * dt);
      this.model.updateMatrixWorld(true);
      this.effectors.forEach((e, k) => pos[k].push(e.bone.getWorldPosition(new THREE.Vector3())));
      hipsPos.push(this.hips.getWorldPosition(new THREE.Vector3()));
      if (i === 0) {
        tmp.set(0, 0, 1).applyQuaternion(this.hips.getWorldQuaternion(q));
        yaw0 = Math.atan2(tmp.x, tmp.z) * 180 / Math.PI;
      }
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
        const prom = r[i] - mn;                           // насколько «выбросило» вперёд
        let vmax = 0;
        for (let j = Math.max(1, i - PW); j <= i; j++) vmax = Math.max(vmax, p[j].distanceTo(p[j - 1]) / dt);
        if (e.kind === 'foot' && p[i].y < 0.3) continue;  // шаг, а не удар
        if (e.kind === 'head' && p[i].y < 1.0) continue;
        if (!((prom >= 0.25 && vmax >= 2.5) || (prom >= 0.2 && vmax >= 6))) continue;
        cands.push({ i, k, prom, vmax, score: vmax * (1 + prom) * (e.kind === 'foot' ? 1.3 : 1) });
      }
    });
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of cands) if (picked.every((p) => Math.abs(p.i - c.i) * dt >= 0.12)) picked.push(c);
    if (!picked.length) {  // нет явных ударов — берём самую быструю точку клипа
      let best = null;
      this.effectors.forEach((e, k) => {
        for (let i = 1; i < N; i++) {
          const v = pos[k][i - 1].distanceTo(pos[k][i + 1]);
          if (!best || v > best.v) best = { i, k, v };
        }
      });
      picked.push(best);
    }
    picked.sort((a, b) => a.i - b.i);
    const yawOff = FACING + (this.idleYaw === undefined ? 0 : angDiff(this.idleYaw, yaw0) * Math.PI / 180);
    const hits = picked.map((c) => {
      const p = pos[c.k];
      const dir = p[c.i].clone().sub(p[Math.max(0, c.i - Math.round(0.08 / dt))]);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      // откуда «наружу» бьёт конечность — шар прилетит с этой стороны
      const out = p[c.i].clone().sub(hipsPos[c.i]); out.y = 0;
      if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
      return {
        time: c.i * dt,
        point: p[c.i].clone().applyAxisAngle(Y_AXIS, yawOff),
        dir: dir.normalize().applyAxisAngle(Y_AXIS, yawOff),
        out: out.normalize().applyAxisAngle(Y_AXIS, yawOff),
        kind: this.effectors[c.k].kind, effector: this.effectors[c.k].name,
      };
    });
    return { hits, yaw0, yawOff };
  }
}

function angDiff(a, b) { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

// Загрузка клипов из .fbx (ArrayBuffer или URL)
export async function loadClips(src) {
  const loader = new FBXLoader();
  const fbx = typeof src === 'string' ? await loader.loadAsync(src) : loader.parse(src, '');
  return fbx.animations;
}
