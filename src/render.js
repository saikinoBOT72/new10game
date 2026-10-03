// Three.js による描画。物理は src/physics.js 側（ここでは読むだけ）。
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { STADIUM, bowlY as floorY, railRadius } from './physics.js';
import { bladeRadius, ratchetRadius, BIT_R, GEAR_R } from './shapes.js';

const S = 10; // 物理の 1m を描画の 10 単位にする
const VIS_SPIN = 0.05; // 見た目の回転速度（実際の回転をそのまま描くとストロボで止まって見える）
const TIME_SCALE_VIS = 1;

export const TEAM_COLORS = [0x3466d8, 0xd2513b];
const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xdde0e6);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 30;
    this.root = new THREE.Group();
    this.root.scale.setScalar(S);
    this.scene.add(this.root);
    this.shake = 0;
    this.trailsOn = true;
    this.mode = 'battle';
    this.raycaster = new THREE.Raycaster();

    this.setupLights();
    this.buildStadium();
    this.sparks = new Sparks(this.root);
    this.debris = [];
    this.beys = [null, null];
    this.trails = [new Trail(this.root, TEAM_COLORS[0]), new Trail(this.root, TEAM_COLORS[1])];
    this.arrow = makeArrow();
    this.arrow.visible = false;
    this.root.add(this.arrow);
    // 引っ張りのゴム
    this.band = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 1, 8), new THREE.MeshBasicMaterial({ color: 0x3466d8 }));
    this.band.visible = false;
    this.root.add(this.band);
    this.zone = null;
    this.setCamera('battle');
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb8bcc6, 1.4);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-1.5, 5, 2.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -2.6; c.right = 2.6; c.top = 2.6; c.bottom = -2.6; c.near = 1; c.far = 12;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
  }

  buildStadium() {
    const st = STADIUM;
    const g = new THREE.Group();
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xfbfbfc, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xdfe2e7, roughness: 0.5, side: THREE.DoubleSide });
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd3d6dc, roughness: 0.6, side: THREE.DoubleSide });

    // 床（回転体）
    const pts = [];
    for (let i = 0; i <= 64; i++) {
      const r = (st.R * i) / 64;
      pts.push(new THREE.Vector2(r, floorY(r)));
    }
    const floor = new THREE.Mesh(new THREE.LatheGeometry(pts, 128), floorMat);
    floor.receiveShadow = true;
    g.add(floor);

    // 床のライン
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xb9bdc5 });
    for (const r of [0.06, 0.125]) g.add(new THREE.Mesh(floorStrip(r - 0.0006, r + 0.0006, 0, Math.PI * 2, 160, 0.0003), lineMat));

    // 壁と外枠（ポケットの部分は開ける）
    const yR = floorY(st.R);
    const ranges = openRanges(st);
    for (const [a0, a1] of ranges) {
      const len = a1 - a0;
      const wall = new THREE.Mesh(
        new THREE.CylinderGeometry(st.R, st.R, st.wallH, Math.max(4, Math.round(len * 40)), 1, true, Math.PI / 2 - a1, len),
        wallMat,
      );
      wall.position.y = yR + st.wallH / 2;
      wall.receiveShadow = true;
      g.add(wall);
      const top = new THREE.Mesh(ringSector(st.R, st.R + 0.03, a0, a1, yR + st.wallH), bodyMat);
      top.receiveShadow = true;
      g.add(top);
      const outer = new THREE.Mesh(
        new THREE.CylinderGeometry(st.R + 0.03, st.R + 0.03, st.wallH + 0.09, Math.max(4, Math.round(len * 40)), 1, true, Math.PI / 2 - a1, len),
        bodyMat,
      );
      outer.position.y = yR + st.wallH - (st.wallH + 0.09) / 2;
      g.add(outer);
    }

    // ポケット
    for (const p of st.pockets) {
      const col = p.type === 'xtreme' ? 0x2a2d35 : 0x50545e;
      const slot = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.004, 2 * Math.sin(p.half) * st.R),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 }),
      );
      const rr = st.R + 0.012;
      slot.position.set(Math.cos(p.center) * rr, yR - 0.03, Math.sin(p.center) * rr);
      slot.rotation.y = -p.center;
      slot.receiveShadow = true;
      g.add(slot);
      // ポケットの入口の坂（エクストリームは高い）
      const ramp = new THREE.Mesh(rampStrip(st.R, st.R + p.lipLen, p.center - p.half, p.center + p.half, floorY(st.R), p.lipH),
        new THREE.MeshStandardMaterial({ color: p.type === 'xtreme' ? 0xf1b11b : 0xb4b9c2, roughness: 0.6, side: THREE.DoubleSide }));
      ramp.receiveShadow = true;
      g.add(ramp);
      const label = textSprite(p.type === 'xtreme' ? 'XTREME' : 'OVER', p.type === 'xtreme' ? '#f1b11b' : '#7d828c');
      label.position.set(Math.cos(p.center) * (st.R + 0.05), yR + 0.03, Math.sin(p.center) * (st.R + 0.05));
      label.scale.set(0.06, 0.015, 1);
      g.add(label);
    }

    // エクストリームライン（ギアレール）: 外周の垂直な段差。奥（射出ポイント）で内側へ曲がる
    const rl = st.rail;
    const railMat = new THREE.MeshStandardMaterial({ color: 0x67c23a, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
    this.railGlow = new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0, side: THREE.DoubleSide });
    const railGeo = railGeometry(rl, 360);
    const rail = new THREE.Mesh(railGeo, railMat);
    rail.castShadow = true;
    rail.receiveShadow = true;
    g.add(rail);
    const glow = new THREE.Mesh(railGeo, this.railGlow);
    glow.scale.setScalar(1.0005);
    g.add(glow);
    // 射出ポイントの目印
    const lp = new THREE.Mesh(floorStrip(railRadius(st.launch.center) - 0.03, railRadius(st.launch.center) - 0.004,
      st.launch.center - st.launch.half, st.launch.center + st.launch.half, 16, 0.0005),
    new THREE.MeshBasicMaterial({ color: 0x3fa7ff, transparent: true, opacity: 0.5 }));
    g.add(lp);
    this.launchGlow = lp.material;
    // レールの内側の歯
    const nTeeth = 220;
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0012, rl.h * 0.8, 0.0014),
      new THREE.MeshStandardMaterial({ color: 0x3f8a22, roughness: 0.5 }), nTeeth);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < nTeeth; i++) {
      const a = (i / nTeeth) * Math.PI * 2;
      const r = railRadius(a) - rl.w * 0.6 - 0.0004;
      q.setFromEuler(new THREE.Euler(0, -a, 0));
      m.compose(new THREE.Vector3(Math.cos(a) * r, floorY(r) + rl.h * 0.45, Math.sin(a) * r), q, new THREE.Vector3(1, 1, 1));
      teeth.setMatrixAt(i, m);
    }
    g.add(teeth);

    // 地面
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ color: 0xd9dce2, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    ground.receiveShadow = true;
    g.add(ground);
    const grid = new THREE.GridHelper(3, 60, 0xc9ccd3, 0xd6d9de);
    grid.position.y = -0.0598;
    g.add(grid);

    this.stadium = g;
    this.root.add(g);
  }

  setCamera(kind) {
    this.mode = kind;
    if (kind === 'preview') {
      this.camera.position.set(0, 1.25, 1.2);
      this.controls.target.set(0, 0.05, 0.08);
      this.controls.enabled = false;
    } else {
      this.fitCamera(kind === 'top' ? 0.02 : null);
      this.controls.enabled = true;
    }
    this.controls.update();
  }

  // スタジアム全体が画面に収まる距離に置く（縦長の画面ほど真上寄り・遠く）
  fitCamera(polar = null) {
    const aspect = this.camera.aspect || 1;
    const p = polar ?? (aspect < 1 ? 0.62 : 0.85); // 真上からの角度
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const radius = (STADIUM.R + 0.04) * S;
    const dist = Math.max(radius / Math.tan(hfov / 2), (radius * Math.cos(p) + 0.6) / Math.tan(vfov / 2)) * 1.08;
    this.camera.position.set(0, Math.cos(p) * dist, Math.sin(p) * dist);
    this.controls.target.set(0, aspect < 1 ? -0.15 : 0.05, 0);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 縦長の画面ではスタジアムが収まるよう視野を広げる
    this.camera.fov = w / h < 0.8 ? 46 : 38;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'battle') this.fitCamera();
  }

  setBey(idx, spec, color = TEAM_COLORS[idx]) {
    if (this.beys[idx]) this.root.remove(this.beys[idx].group);
    const v = buildBeyMesh(spec, color);
    this.beys[idx] = v;
    this.root.add(v.group);
    this.trails[idx].reset();
    return v;
  }

  clearDebris() {
    for (const d of this.debris) this.root.remove(d.obj);
    this.debris = [];
  }

  // 戦闘開始前（宙に浮いた状態）
  placeReady(idx, x, z) {
    const v = this.beys[idx];
    if (!v) return;
    v.group.visible = true;
    v.group.position.set(x, floorY(Math.hypot(x, z)) + 0.003, z);
    v.group.quaternion.identity();
    v.visualPhase = 0;
    v.spinner.rotation.y = 0;
    v.blur.material.opacity = 0;
    this.trails[idx].reset();
  }

  showArrow(x, z, angle, power, color, opacity = 0.6) {
    this.arrow.visible = true;
    this.arrow.material.color.set(color);
    this.arrow.material.opacity = opacity;
    const y = floorY(Math.hypot(x, z)) + 0.04;
    this.arrow.position.set(x, y, z);
    this.arrow.rotation.set(0, -angle, 0);
    const len = 0.03 + power * 0.1;
    this.arrow.scale.set(len, 1, 0.55 + power * 0.45);
  }

  hideArrow() {
    this.arrow.visible = false;
  }

  // コマから引っ張った方向へ伸びるゴム
  showBand(x, z, angle, len, color) {
    const y = floorY(Math.hypot(x, z)) + 0.04;
    const ex = x + Math.cos(angle) * len;
    const ez = z + Math.sin(angle) * len;
    const a = new THREE.Vector3(x, y, z);
    const b = new THREE.Vector3(ex, floorY(Math.hypot(ex, ez)) + 0.04, ez);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    this.band.position.copy(mid);
    this.band.scale.set(1, a.distanceTo(b), 1);
    this.band.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.band.material.color.set(color);
    this.band.visible = true;
  }

  hideBand() {
    this.band.visible = false;
  }

  // スタート位置を置ける範囲（扇形）
  showZone(a0, a1, r0, r1, color) {
    this.hideZone();
    this.zone = new THREE.Mesh(floorStrip(r0, r1, a0, a1, 48, 0.0015),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    this.root.add(this.zone);
  }

  hideZone() {
    if (!this.zone) return;
    this.root.remove(this.zone);
    this.zone.geometry.dispose();
    this.zone = null;
  }

  // 画面座標 → 床（y=0 付近）の物理座標
  pickFloor(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.01 * S);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return null;
    return { x: p.x / S, z: p.z / S };
  }

  onEvent(ev) {
    if (ev.type === 'hit') {
      const k = Math.min(1, ev.strength / 0.05);
      // 中層（ラチェット）への当たりは低い位置で赤い火花
      const col = ev.low ? 0xff6a4a : ev.same ? 0xffd25a : 0x9fe3ff;
      this.sparks.emit(ev.x, floorY(Math.hypot(ev.x, ev.z)) + (ev.low ? 0.011 : 0.018), ev.z, ev.nx, ev.nz, Math.round(6 + 34 * k), col);
      this.shake = Math.max(this.shake, k * 0.05);
    } else if (ev.type === 'wall') {
      const k = Math.min(1, ev.strength / 0.05);
      const r = Math.hypot(ev.x, ev.z);
      this.sparks.emit(ev.x, floorY(r) + 0.016, ev.z, -ev.x / r, -ev.z / r, Math.round(3 + 12 * k), 0xffe7a0);
    } else if (ev.type === 'dash') {
      this.launchGlow.opacity = 1;
      this.sparks.emit(ev.x, floorY(Math.hypot(ev.x, ev.z)) + 0.01, ev.z, 0, 0, 24, 0x7fd0ff);
    } else if (ev.type === 'burst') {
      this.burst(ev);
      this.shake = 0.12;
    } else if (ev.type === 'over' || ev.type === 'xtreme') {
      this.shake = ev.type === 'xtreme' ? 0.1 : 0.06;
    }
  }

  burst(ev) {
    const v = this.beys[ev.idx];
    if (!v) return;
    v.group.updateMatrixWorld();
    const base = new THREE.Vector3();
    v.group.getWorldPosition(base);
    const pieces = [v.parts.blade, v.parts.ratchet, v.parts.bit];
    pieces.forEach((obj, i) => {
      const wp = new THREE.Vector3();
      obj.getWorldPosition(wp);
      this.root.worldToLocal(wp);
      const holder = new THREE.Group();
      holder.position.copy(wp);
      obj.position.set(0, 0, 0);
      holder.add(obj);
      this.root.add(holder);
      const a = Math.random() * Math.PI * 2;
      const sp = 0.25 + Math.random() * 0.45;
      this.debris.push({
        obj: holder,
        vx: ev.vx * 0.6 + Math.cos(a) * sp, vz: ev.vz * 0.6 + Math.sin(a) * sp,
        vy: 0.5 + Math.random() * 0.5 + (i === 0 ? 0.3 : 0),
        spin: ev.w * 0.02, rx: (Math.random() - 0.5) * 20, rz: (Math.random() - 0.5) * 20,
        rest: false,
      });
    });
    v.group.visible = false;
    this.sparks.emit(ev.x, floorY(Math.hypot(ev.x, ev.z)) + 0.02, ev.z, 0, 0, 60, 0xffffff);
  }

  update(world, dt) {
    let railOn = false;
    if (world) {
      world.beys.forEach((b, i) => {
        const v = this.beys[i];
        if (!v || b.state === 'ready' || b.state === 'burst') return;
        // 物理の姿勢（軸の向き）と軸先の位置をそのまま使う。回転の位相だけは見やすい速さに落とす
        v.group.position.set(b.x, b.y, b.z);
        v.group.quaternion.setFromUnitVectors(UP, tmpV.set(b.axis[0], b.axis[1], b.axis[2]));
        v.visualPhase += b.spin * VIS_SPIN * dt * TIME_SCALE_VIS;
        v.spinner.rotation.y = v.visualPhase;
        const spinRatio = Math.min(1, Math.abs(b.spin) / 900);
        v.blur.material.opacity = b.state === 'spin' ? 0.55 * Math.pow(spinRatio, 0.7) : 0;
        if (b.onRail) railOn = true;
        if (this.trailsOn && b.state === 'spin') this.trails[i].push(b.x, b.y + 0.001, b.z);
      });
    }
    this.railGlow.opacity += ((railOn ? 0.75 : 0) - this.railGlow.opacity) * Math.min(1, dt * 10);
    this.launchGlow.opacity += (0.5 - this.launchGlow.opacity) * Math.min(1, dt * 3);
    this.trails.forEach((t) => (t.line.visible = this.trailsOn));

    for (const d of this.debris) {
      if (d.rest) continue;
      d.vy -= 9.81 * dt;
      const o = d.obj.position;
      o.x += d.vx * dt;
      o.z += d.vz * dt;
      o.y += d.vy * dt;
      const r = Math.hypot(o.x, o.z);
      let fy = r < STADIUM.R ? floorY(r) : -0.06;
      if (r > STADIUM.R && r < STADIUM.R + 0.03) fy = floorY(STADIUM.R) + STADIUM.wallH;
      if (o.y > STADIUM.ceiling) { o.y = STADIUM.ceiling; d.vy = -Math.abs(d.vy) * 0.3; }
      if (r < STADIUM.R && r > STADIUM.R - 0.01) {
        d.vx *= -0.4; d.vz *= -0.4;
      }
      if (o.y < fy + 0.003) {
        o.y = fy + 0.003;
        d.vy = Math.abs(d.vy) * 0.3;
        d.vx *= 0.7; d.vz *= 0.7;
        d.rx *= 0.6; d.rz *= 0.6;
        if (Math.abs(d.vy) < 0.05 && Math.hypot(d.vx, d.vz) < 0.02) d.rest = true;
      }
      d.obj.rotation.x += d.rx * dt;
      d.obj.rotation.z += d.rz * dt;
      d.obj.rotation.y += d.spin * dt;
    }

    this.sparks.update(dt);
    this.controls.update();
    const base = this.camera.position.clone();
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.pow(0.02, dt);
    }
    this.renderer.render(this.scene, this.camera);
    this.camera.position.copy(base);
  }

  // カスタマイズ画面: 2つのコマを並べてゆっくり回す
  updatePreview(dt) {
    this.beys.forEach((v, i) => {
      if (!v) return;
      v.group.visible = true;
      const x = i === 0 ? -0.04 : 0.04;
      v.group.position.set(x, 0.006, 0.0);
      v.visualPhase += v.spinSign * dt * 2.2;
      v.spinner.rotation.y = v.visualPhase;
      v.group.quaternion.identity();
      v.blur.material.opacity = 0;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// ポケット以外の角度範囲
function openRanges(st) {
  const ps = st.pockets.map((p) => [p.center - p.half, p.center + p.half]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const a0 = ps[i][1];
    let a1 = i + 1 < ps.length ? ps[i + 1][0] : ps[0][0] + Math.PI * 2;
    out.push([a0, a1]);
  }
  return out;
}

// 床の起伏に沿った帯（物理の角度 atan2(z,x) で指定）
function floorStrip(r0, r1, a0, a1, segs, lift) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c * r0, floorY(r0) + lift, s * r0, c * r1, floorY(r1) + lift, s * r1);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// レール: 上面と内外の垂直な面
function railGeometry(rl, segs) {
  const pos = [];
  const idx = [];
  const face = rl.w * 0.6;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const rho = railRadius(a);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ri = rho - face;
    const ro = rho + face;
    const yi = floorY(ri);
    const yo = floorY(ro);
    const top = floorY(rho) + rl.h;
    // 内側の面の下、内側の上、外側の上、外側の下
    pos.push(c * ri, yi, s * ri, c * ri, top, s * ri, c * ro, top, s * ro, c * ro, yo, s * ro);
    if (i < segs) {
      const k = i * 4;
      for (let j = 0; j < 3; j++) idx.push(k + j, k + j + 1, k + j + 4, k + j + 1, k + j + 5, k + j + 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ポケット入口の坂
function rampStrip(r0, r1, a0, a1, y0, h) {
  const pos = [];
  const idx = [];
  const segs = 12;
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c * r0, y0 + 0.0005, s * r0, c * r1, y0 + h, s * r1);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ringSector(r0, r1, a0, a1, y) {
  const segs = Math.max(4, Math.round((a1 - a0) * 40));
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    pos.push(Math.cos(a) * r0, y, Math.sin(a) * r0, Math.cos(a) * r1, y, Math.sin(a) * r1);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function textSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
}

function makeArrow() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.12);
  s.lineTo(0.62, -0.12);
  s.lineTo(0.62, -0.3);
  s.lineTo(1, 0);
  s.lineTo(0.62, 0.3);
  s.lineTo(0.62, 0.12);
  s.lineTo(0, 0.12);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2); // shape の y → -z
  g.scale(1, 1, 0.09);
  const m = new THREE.MeshBasicMaterial({ color: 0x3466d8, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
  return new THREE.Mesh(g, m);
}

// ---- コマのメッシュ ----

export function buildBeyMesh(spec, color) {
  const { blade, ratchet, bit } = spec;
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  group.add(spinner);

  const bladeMat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.25 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0xc9ced8, roughness: 0.25, metalness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x33363d, roughness: 0.5, metalness: 0.2 });
  const grayMat = new THREE.MeshStandardMaterial({ color: 0x6c717b, roughness: 0.45, metalness: 0.3 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf5f6f8, roughness: 0.4 });

  // ブレード
  const bladeG = new THREE.Group();
  const shape = new THREE.Shape();
  const N = 180;
  for (let i = 0; i <= N; i++) {
    const phi = (i / N) * Math.PI * 2;
    const r = bladeRadius(blade.shape, blade.R, phi, spec.spinSign);
    const x = Math.cos(phi) * r;
    const y = Math.sin(phi) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const thick = blade.t;
  const bg = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: 0.0007, bevelSize: 0.0006, bevelSegments: 2, curveSegments: 4 });
  bg.rotateX(-Math.PI / 2);
  bg.translate(0, -thick / 2, 0);
  const bladeMesh = new THREE.Mesh(bg, bladeMat);
  bladeMesh.castShadow = true;
  bladeMesh.receiveShadow = true;
  bladeG.add(bladeMesh);
  // メタルのリング
  const ring = new THREE.Mesh(new THREE.TorusGeometry(blade.R * 0.72, 0.0012, 8, 48), metalMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = thick / 2 + 0.0006;
  bladeG.add(ring);
  // 中央のキャップ（回転が見えるように柄を入れる）
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.0105, 0.004, 32), whiteMat);
  cap.position.y = thick / 2 + 0.0015;
  cap.castShadow = true;
  bladeG.add(cap);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.0012, 0.0035), bladeMat);
  stripe.position.y = thick / 2 + 0.0036;
  bladeG.add(stripe);
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0014, 16), darkMat);
  dot.position.set(0.0055, thick / 2 + 0.0038, 0);
  bladeG.add(dot);
  bladeG.position.y = spec.H;
  spinner.add(bladeG);

  // ラチェット（物理と同じ輪郭を押し出す）
  const ratG = new THREE.Group();
  const rs = new THREE.Shape();
  for (let i = 0; i <= 128; i++) {
    const phi = (i / 128) * Math.PI * 2;
    const r = ratchetRadius(ratchet, phi);
    const x = Math.cos(phi) * r;
    const y = Math.sin(phi) * r;
    if (i === 0) rs.moveTo(x, y);
    else rs.lineTo(x, y);
  }
  const rg = new THREE.ExtrudeGeometry(rs, { depth: ratchet.h * 0.96, bevelEnabled: false, curveSegments: 2 });
  rg.rotateX(-Math.PI / 2);
  rg.translate(0, -ratchet.h * 0.48, 0);
  const rat = new THREE.Mesh(rg, grayMat);
  rat.castShadow = true;
  ratG.add(rat);
  ratG.position.y = bit.h + ratchet.h / 2;
  spinner.add(ratG);

  // ビット（ギア＋先端）
  const bitG = new THREE.Group();
  const bodyH = bit.h * 0.5;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(BIT_R, BIT_R * 0.92, bodyH, 24), darkMat);
  body.position.y = bit.h - bodyH / 2;
  body.castShadow = true;
  bitG.add(body);
  const nT = 14;
  for (let i = 0; i < nT; i++) {
    const a = (i / nT) * Math.PI * 2;
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.0022, 0.0016), metalMat);
    t.position.set(Math.cos(a) * GEAR_R, bit.h * 0.45, Math.sin(a) * GEAR_R);
    t.rotation.y = -a;
    bitG.add(t);
  }
  const tipH = bit.h - bodyH;
  let tip;
  const tipMat = bit.id === 'RF' ? new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.95 }) : whiteMat;
  if (bit.shape === 'ball') {
    tip = new THREE.Mesh(new THREE.SphereGeometry(tipH * 0.62, 20, 14), tipMat);
    tip.position.y = tipH * 0.62;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.006, tipH * 0.55, tipH * 0.5, 20), tipMat);
    neck.position.y = tipH * 0.78;
    bitG.add(neck);
  } else if (bit.shape === 'needle') {
    tip = new THREE.Mesh(new THREE.ConeGeometry(0.0055, tipH, 20), tipMat);
    tip.rotation.x = Math.PI;
    tip.position.y = tipH / 2;
  } else if (bit.shape === 'point') {
    tip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, bit.a + 0.0006, tipH, 20), tipMat);
    tip.position.y = tipH / 2;
  } else {
    tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, bit.a + 0.0012, tipH, 24), tipMat);
    tip.position.y = tipH / 2;
  }
  tip.castShadow = true;
  bitG.add(tip);
  spinner.add(bitG);

  // 高速回転のぶれ
  const blur = new THREE.Mesh(
    new THREE.RingGeometry(blade.R * 0.55, blade.R * 1.01, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  blur.rotation.x = -Math.PI / 2;
  blur.position.y = spec.H + thick / 2 + 0.0009;
  group.add(blur);

  return { group, spinner, blur, parts: { blade: bladeG, ratchet: ratG, bit: bitG }, visualPhase: 0, spinSign: spec.spinSign };
}

class Sparks {
  constructor(parent) {
    this.max = 600;
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo = g;
    const m = new THREE.PointsMaterial({ size: 0.0035, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    parent.add(this.points);
    for (let i = 0; i < this.max; i++) this.pos[i * 3 + 1] = -10;
  }

  emit(x, y, z, nx, nz, count, color) {
    const c = new THREE.Color(color);
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const sp = 0.3 + Math.random() * 1.2;
      // 接線方向に強く飛ぶ
      this.vel[i * 3] = Math.cos(a) * sp + nz * (Math.random() - 0.5) * 2;
      this.vel[i * 3 + 1] = Math.random() * 0.9;
      this.vel[i * 3 + 2] = Math.sin(a) * sp - nx * (Math.random() - 0.5) * 2;
      this.life[i] = 0.25 + Math.random() * 0.3;
      this.col[i * 3] = c.r;
      this.col[i * 3 + 1] = c.g;
      this.col[i * 3 + 2] = c.b;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 6 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const f = Math.max(0, Math.min(1, this.life[i] * 3));
      this.col[i * 3] *= 0.9 + 0.1 * f;
      this.col[i * 3 + 1] *= 0.86 + 0.14 * f;
      this.col[i * 3 + 2] *= 0.8 + 0.2 * f;
      if (this.life[i] <= 0) this.pos[i * 3 + 1] = -10;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

class Trail {
  constructor(parent, color) {
    this.n = 240;
    this.buf = new Float32Array(this.n * 3);
    this.count = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.buf, 3));
    g.setDrawRange(0, 0);
    this.geo = g;
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
    this.line.frustumCulled = false;
    parent.add(this.line);
    this.skip = 0;
  }

  reset() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }

  push(x, y, z) {
    if ((this.skip = (this.skip + 1) % 2) !== 0) return;
    if (this.count < this.n) this.count++;
    else this.buf.copyWithin(0, 3);
    const i = (this.count - 1) * 3;
    this.buf[i] = x;
    this.buf[i + 1] = y;
    this.buf[i + 2] = z;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.setDrawRange(0, this.count);
  }
}
