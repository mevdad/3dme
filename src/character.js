import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const HEIGHT = 1.8;        // м, итоговый рост персонажа
const FADE = 0.12;         // с, кроссфейд между позами
const EFFECTORS = {
  LeftHand: 'hand', RightHand: 'hand', LeftFoot: 'foot', RightFoot: 'foot',
};

// Персонаж на Mixamo-скелете: стойка в покое + приёмы (атаки).
// Для каждого приёма автоматически находится момент и точка удара —
// конечность, которая быстро летит дальше всего вперёд (+Z).
export class Character {
  constructor(scene) {
    this.root = new THREE.Group();
    scene.add(this.root);
    this.moves = [];
    this.idleAction = null;
    this.current = null;
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
    this.effectors = Object.keys(EFFECTORS).map((n) => ({
      kind: EFFECTORS[n], name: n, bone: fbx.getObjectByName('mixamorig' + n),
    })).filter((e) => e.bone);

    // масштаб по росту в bind-позе
    fbx.updateMatrixWorld(true);
    const bind = new THREE.Box3().setFromObject(this.skinned, true);
    fbx.scale.setScalar(HEIGHT / bind.getSize(new THREE.Vector3()).y);

    const clips = fbx.animations;
    if (clips.length) {
      this.#ground(clips[0]);
      const first = this.addMove(clips[0], null);
      this.setIdle(null, clips[0]); // пока нет idle — замираем в стойке из первого кадра
      return first;
    }
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

  // добавляет приём; name по умолчанию определяется по конечности
  addMove(clip, name) {
    const hit = this.#analyze(clip);
    if (this.idleAction) { this.#startIdle(0); this.current = null; } // анализ сбросил микшер
    const move = {
      clip, hit,
      hitTime: hit.time,
      name: name || (hit.kind === 'foot' ? 'Kick' : 'Punch'),
    };
    this.moves.push(move);
    return move;
  }

  // idle: зацикленный клип, либо (clip=null) заморозка кадра 0 из frozenFrom
  setIdle(clip, frozenFrom) {
    const prev = this.idleAction;
    const c = clip || frozenFrom;
    this.idleAction = this.mixer.clipAction(c);
    this.idleFrozen = !clip;
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.#startIdle(0);
    if (prev && prev !== this.idleAction) prev.fadeOut(FADE);
  }

  #startIdle(fade) {
    const a = this.idleAction;
    a.reset();
    a.paused = this.idleFrozen;
    if (fade) a.fadeIn(fade); else a.setEffectiveWeight(1);
    a.play();
  }

  play(move) {
    const a = this.mixer.clipAction(move.clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.fadeIn(FADE).play();
    this.current = { action: a, move };
  }

  update(dt) {
    const c = this.current;
    if (c && c.action.time >= c.move.clip.duration - FADE) {
      c.action.fadeOut(FADE);
      this.#startIdle(FADE);
      this.current = null;
    }
    this.mixer?.update(dt);
  }

  // Сэмплируем клип и ищем точку удара.
  #analyze(clip) {
    const dur = clip.duration;
    const N = Math.max(8, Math.ceil(dur * 60));
    const dt = dur / N;
    const act = this.mixer.clipAction(clip).play();
    const pos = this.effectors.map(() => []);
    for (let i = 0; i <= N; i++) {
      this.mixer.setTime(i * dt);
      this.model.updateMatrixWorld(true);
      this.effectors.forEach((e, k) => pos[k].push(e.bone.getWorldPosition(new THREE.Vector3())));
    }
    act.stop();
    this.mixer.stopAllAction();

    const W = Math.max(2, Math.round(0.1 / dt)); // окно ±0.1 с
    let best = null;
    this.effectors.forEach((e, k) => {
      const p = pos[k];
      for (let i = W; i <= N - W; i++) {
        let path = 0;
        for (let j = i - W; j < i + W; j++) path += p[j].distanceTo(p[j + 1]);
        const speed = path / (2 * W * dt);
        if (speed < 1.0) continue; // опорная нога и «просто стоящие» конечности
        if (!best || p[i].z > best.pos.z) best = { i, k, pos: p[i], speed };
      }
    });
    if (!best) { // нет быстрых движений вперёд — берём самую быструю точку
      this.effectors.forEach((e, k) => {
        for (let i = 1; i < N; i++) {
          const speed = pos[k][i - 1].distanceTo(pos[k][i + 1]);
          if (!best || speed > best.speed) best = { i, k, pos: pos[k][i], speed };
        }
      });
    }
    const p = pos[best.k];
    const back = Math.max(0, best.i - Math.round(0.08 / dt));
    const dir = best.pos.clone().sub(p[back]);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    return {
      time: best.i * dt,
      point: best.pos.clone(),
      dir: dir.normalize(),
      kind: this.effectors[best.k].kind,
      effector: this.effectors[best.k].name,
    };
  }
}

// Загрузка клипов из .fbx (ArrayBuffer или URL)
export async function loadClips(src) {
  const loader = new FBXLoader();
  const fbx = typeof src === 'string' ? await loader.loadAsync(src) : loader.parse(src, '');
  return fbx.animations;
}
