// コマバトルの物理演算（描画なし・決定的）。ゲーム用の補正値は使わず、形状と物理量だけで計算する。
//
// ■ 剛体
//   各コマは位置・姿勢（クォータニオン）・速度・角運動量を持つ 3D 剛体。
//   重さ・重心・慣性テンソルは、パーツの形（極座標の輪郭を押し出した立体）と重量から積分して求める。
//   姿勢の時間発展は角運動量 L を保存量として扱い、ω = I⁻¹(t) L で更新する（歳差・章動は自然に出る）。
//
// ■ 接触（すべて撃力ベースの逐次インパルス法。反発係数とクーロン摩擦）
//   - 軸先と床: 軸先を「半径 a の円板を半径 rr の球でなぞった形」として、床に一番近い点で接触。
//     平らな軸先は縁が床に当たって転がるので、自然に走り回る。点接触の軸先はヘルツ接触の
//     接触円の大きさから回転摩擦（ねじり摩擦）を計算する。
//   - コマどうし: ブレード・ラチェット・ビットそれぞれの輪郭どうしで判定する。刃の面の向きが
//     そのまま撃力の向きになる。高さの帯が重なる部分だけが当たる。
//   - 壁: 輪郭の一番外側の点と円筒の壁。ポケットの部分には壁がない。
//   - レール: ビットのギア（円筒）とスタジアム外周の段差。歯の噛み合いを高い摩擦で表し、
//     半クラッチが伝えられるトルクで接線方向の力積を頭打ちにする。
//   - 傾いて倒れたときは、ブレードやラチェットの下面の縁が床をこする。
//
// ■ バースト
//   ブレード（上層）とコア（ラチェット＋ビット）はロックでつながった別の物体とみなす。
//   コアが回転を止める向きに叩かれると、ブレードは慣性で回り続けようとするので、ロックには
//   「叩かれた角力積 × ブレードの慣性の割合」がかかる（上層を叩かれたときはコアの慣性の割合）。
//   ロックが保持できるトルクを超えた分が負荷として4段のゲージに溜まり、満タンで分解する。
//   ロックの強さはビットのシャフトの太さ（爪の締め付け）で決まる。

import { NPOLAR, polarTable, bladeRadius, ratchetRadius, BIT_R, GEAR_R } from './shapes.js';
import { MATERIALS, SHAFT } from './parts.js';

export const G = 9.81;
const TAU = Math.PI * 2;
const DPHI = TAU / NPOLAR;

const deg = (d) => (d * Math.PI) / 180;

export const STADIUM = {
  R: 0.19, // 壁の内半径
  wallH: 0.04,
  ceiling: 0.085, // 透明カバーの高さ（床の中心から）。壁はカバーまでつながっている
  pocketTop: 0.035, // ポケットの開口の高さ（壁の位置の床から）
  // 床の断面: 中央は y = curve r² のボウル。外周（レールのあたり）に向かって傾きをゆるめ、
  // ほぼ平らなリングにつなぐ（急な斜面のままだと、外へ走ったコマが坂で跳ね上がってしまう）
  curve: 0.5,
  bowlR: 0.12, // ここまでボウル
  flatR: 0.16, // ここから外は傾き outSlope の平らなリング
  outSlope: 0.06,
  // エクストリームライン: 外周の段差（ギアが噛む）。奥（-z）で内側に曲がり、射出ポイントになる
  rail: { r: 0.171, h: 0.0045, w: 0.0035, notchAt: deg(-90), notchDepth: 0.026, notchWidth: 0.22 },
  launch: { center: deg(-90), half: deg(14) },
  pockets: [
    // エクストリームゾーンは入口が高い。オーバーゾーンはなだらか
    { type: 'xtreme', center: deg(90), half: deg(15), lipLen: 0.012, lipH: 0.011 },
    { type: 'over', center: deg(38), half: deg(9), lipLen: 0.01, lipH: 0.0025 },
    { type: 'over', center: deg(142), half: deg(9), lipLen: 0.01, lipH: 0.0025 },
  ],
  pit: -0.08,
};

const AIR_RHO = 1.2;
const C_DRAG = 1.2; // 段差の面にかかる圧力抵抗
const C_SKIN = 0.012; // 表面の摩擦抵抗
const E_STAR = 1.2e9; // プラスチックの接触の等価ヤング率（ヘルツ接触）
const SLOP = 0.00015;
const E_YIELD_V = 0.5; // これより速い衝突では反発係数が下がり始める [m/s]
const ITER = 8;
const DT_COARSE = 1 / 4000;
const DT_FINE_MIN = 1 / 40000;
const DT_SOFT = 8e-5; // 柔らかい接触を安定に解ける刻み幅
// コマどうし・壁・天井の接触は「接触剛性＋減衰」の柔らかい接触として力で解く。
// 剛体の撃力だと刃先の表面速度（秒速20m以上）の分の運動量が一瞬で全部受け渡されてしまうが、
// 実際は接触面がわずかにたわむあいだ（約0.4ms）に刃先が滑って抜けるので、受け渡しは途中で終わる
const K_SOFT = 1.5e5; // 接触剛性 [N/m]（金属ブレードとプラスチックの取り付け部のたわみ込み）
const V_SLIP = 0.05; // 摩擦の向きを決めるときの最小すべり速度 [m/s]

// ロック（バースト機構）
export const LOCK_STEPS = 4;
const LOCK_HOLD = 0.02; // ロックが保持できるトルク [N·m]（これを超えた分が負荷になる）
const LOCK_FULL = 0.9e-3; // 満タンまでに必要な角力積 [N·m·s]（シャフトの締め付けで倍率がかかる）
const LOCK_HEAL = 0.06; // 自然回復 [ゲージ/秒]（今いる段の区切りより下には戻らない）

// ---------------- 小さな数学 ----------------

function qMat(q, m) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w);
  m[3] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - x * w);
  m[6] = 2 * (x * z - y * w); m[7] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
  return m;
}

function inv3(a) {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const c0 = a4 * a8 - a5 * a7;
  const c1 = a5 * a6 - a3 * a8;
  const c2 = a3 * a7 - a4 * a6;
  const det = a0 * c0 + a1 * c1 + a2 * c2;
  const id = 1 / det;
  return [
    c0 * id, (a2 * a7 - a1 * a8) * id, (a1 * a5 - a2 * a4) * id,
    c1 * id, (a0 * a8 - a2 * a6) * id, (a2 * a3 - a0 * a5) * id,
    c2 * id, (a1 * a6 - a0 * a7) * id, (a0 * a4 - a1 * a3) * id,
  ];
}

// ---------------- スタジアムの形 ----------------

export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function bowlY(r, st = STADIUM) {
  const rc = Math.min(r, st.R);
  const r0 = st.bowlR;
  if (rc <= r0) return st.curve * rc * rc;
  const y0 = st.curve * r0 * r0;
  const s0 = 2 * st.curve * r0;
  const r1 = st.flatR;
  const k = (s0 - st.outSlope) / (2 * (r1 - r0));
  if (rc <= r1) return y0 + s0 * (rc - r0) - k * (rc - r0) * (rc - r0);
  const y1 = y0 + s0 * (r1 - r0) - k * (r1 - r0) * (r1 - r0);
  return y1 + st.outSlope * (rc - r1);
}

export function pocketAt(phi, st = STADIUM) {
  for (const p of st.pockets) if (Math.abs(wrap(phi - p.center)) < p.half) return p;
  return null;
}

export function railRadius(phi, st = STADIUM) {
  const rl = st.rail;
  const d = wrap(phi - rl.notchAt) / rl.notchWidth;
  return rl.r - rl.notchDepth * Math.exp(-d * d);
}

// 床の高さ（ボウル＋ポケットの坂）
export function floorY(x, z, st = STADIUM) {
  const r = Math.hypot(x, z);
  const phi = Math.atan2(z, x);
  // レールは垂直な面を持つ段差なので床の起伏には含めない（ギアとの接触で扱う）
  if (r <= st.R) return bowlY(r, st);
  const p = pocketAt(phi, st);
  if (!p) return bowlY(st.R, st); // 壁の向こう（壁の接触で止まるので、床としては平らに続ける）
  const s = r - st.R;
  if (s < p.lipLen) return bowlY(st.R, st) + p.lipH * (s / p.lipLen);
  return st.pit;
}

const NH = 0.0004;
function floorNormal(x, z, out, st = STADIUM) {
  const a = floorY(x + NH, z, st);
  const b = floorY(x - NH, z, st);
  const c = floorY(x, z + NH, st);
  const d = floorY(x, z - NH, st);
  if (a < st.pit + 0.01 || b < st.pit + 0.01 || c < st.pit + 0.01 || d < st.pit + 0.01) {
    out[0] = 0; out[1] = 1; out[2] = 0;
    return out;
  }
  const gx = (a - b) / (2 * NH);
  const gz = (c - d) / (2 * NH);
  const m = Math.hypot(gx, 1, gz);
  out[0] = -gx / m; out[1] = 1 / m; out[2] = -gz / m;
  return out;
}

// ---------------- 質量特性（形から積分） ----------------

// 輪郭 R(φ) と内径 rin のあいだを y0..y1 に押し出した立体（パーツ座標の原点まわり）
function layerMass(R, rin, y0, y1, m) {
  let A = 0, Sx = 0, Sz = 0, Sxx = 0, Szz = 0, Sxz = 0;
  for (let k = 0; k < NPOLAR; k++) {
    const r = typeof R === 'number' ? R : R[k];
    const phi = k * DPHI;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const m3 = (r * r * r - rin * rin * rin) / 3;
    const m4 = (r * r * r * r - rin * rin * rin * rin) / 4;
    A += ((r * r - rin * rin) / 2) * DPHI;
    Sx += c * m3 * DPHI;
    Sz += s * m3 * DPHI;
    Sxx += c * c * m4 * DPHI;
    Szz += s * s * m4 * DPHI;
    Sxz += c * s * m4 * DPHI;
  }
  const sigma = m / A; // 面密度×厚み
  const t = y1 - y0;
  const cx = (sigma * Sx) / m;
  const cz = (sigma * Sz) / m;
  const cy = (y0 + y1) / 2;
  const yy = cy * cy + (t * t) / 12;
  const I = [
    sigma * Szz + m * yy, -m * cx * cy, -sigma * Sxz,
    -m * cx * cy, sigma * (Sxx + Szz), -m * cy * cz,
    -sigma * Sxz, -m * cy * cz, sigma * Sxx + m * yy,
  ];
  return { m, c: [cx, cy, cz], I, Iaxis: sigma * (Sxx + Szz) };
}

// 段差の面にかかる空気抵抗と表面摩擦から、空気抵抗トルクの係数 τ = -k |ω| ω を求める
function airCoef(table, t, spinSign) {
  let lead = 0;
  for (let k = 0; k < NPOLAR; k++) {
    const r0 = table.R[k];
    const r1 = table.R[(k + 1) % NPOLAR];
    const dr = spinSign < 0 ? r1 - r0 : r0 - r1; // 回転の進行方向を向いた面
    if (dr > 0) lead += dr * r0 * r0 * r0;
  }
  const rm = table.rmax;
  return 0.5 * AIR_RHO * (C_DRAG * t * lead + C_SKIN * ((4 * Math.PI) / 5) * rm ** 5);
}

export function buildSpec(blade, ratchet, bit) {
  const spinSign = blade.spin === 'L' ? 1 : -1;
  const bladeT = polarTable((phi) => bladeRadius(blade.shape, blade.R, phi, spinSign));
  const ratT = polarTable((phi) => ratchetRadius(ratchet, phi));
  const bitT = polarTable(() => BIT_R);

  // パーツ座標: 軸先の最下点が原点、y が回転軸
  const yr0 = bit.h;
  const yr1 = bit.h + ratchet.h;
  const yb0 = yr1;
  const yb1 = yr1 + blade.t;

  const parts = [
    layerMass(bladeT.R, blade.metalIn, yb0, yb1, blade.m - blade.hub),
    layerMass(blade.metalIn, 0, yb0, yb1, blade.hub),
    layerMass(ratT.R, 0.004, yr0, yr1, ratchet.m),
    layerMass(BIT_R, 0, 0, bit.h, bit.m),
  ];
  let m = 0;
  const c = [0, 0, 0];
  const Io = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of parts) {
    m += p.m;
    for (let i = 0; i < 3; i++) c[i] += p.m * p.c[i];
    for (let i = 0; i < 9; i++) Io[i] += p.I[i];
  }
  for (let i = 0; i < 3; i++) c[i] /= m;
  // 重心まわりへ平行移動
  const c2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
  const Ic = Io.slice();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) Ic[i * 3 + j] -= m * ((i === j ? c2 : 0) - c[i] * c[j]);
  }
  const Iinv = inv3(Ic);
  const IbladeAxis = parts[0].Iaxis + parts[1].Iaxis;
  const IcoreAxis = parts[2].Iaxis + parts[3].Iaxis;

  const mat = (k) => MATERIALS[k];
  const layers = [
    { part: 'blade', table: bladeT, y0: yb0, y1: yb1, mat: mat('metal') },
    { part: 'ratchet', table: ratT, y0: yr0, y1: yr1, mat: mat('plastic') },
    { part: 'bit', table: bitT, y0: bit.h * 0.35, y1: bit.h, mat: mat('plastic') },
  ];
  const tipMat = mat(bit.tipMat);
  const N0 = m * G;
  // 点接触の軸先: ヘルツの接触円の半径 → ねじり摩擦の腕の長さ
  const aHertz = Math.cbrt((3 * N0 * bit.rr) / (4 * E_STAR));
  return {
    blade, ratchet, bit, spinSign,
    m, com: c, I: Ic, Iinv,
    IbladeAxis, IcoreAxis, IaxisTotal: IbladeAxis + IcoreAxis,
    layers, rmax: Math.max(bladeT.rmax, ratT.rmax, BIT_R),
    tip: {
      a: bit.a, rr: bit.rr, mu: (tipMat.mu + MATERIALS.plastic.mu) / 2, e: 0.15,
      torsion: (3 * Math.PI / 16) * aHertz,
      flex: bit.tipMat === 'rubber' ? 0.06 : 0.02, // 圧力中心が縁まで移る傾き [rad]（ゴムは変形が大きい）
    },
    gear: { y0: bit.h * 0.3, y1: bit.h * 0.6, clutch: bit.clutch },
    air: airCoef(bladeT, blade.t, spinSign) + airCoef(ratT, ratchet.h, spinSign),
    lockFull: LOCK_FULL * SHAFT[bit.shaft].clamp,
    H: (yb0 + yb1) / 2, // ブレード中心の高さ（軸先から）
    bladeBand: [yb0, yb1],
    ratchetBand: [yr0, yr1],
  };
}

// ---------------- 世界 ----------------

export function createBattle(specs, { seed = 1, stadium = STADIUM } = {}) {
  return {
    st: stadium,
    t: 0,
    rng: makeRng(seed),
    events: [],
    beys: specs.map((spec, i) => newBey(spec, i)),
    contacts: [],
  };
}

function newBey(spec, idx) {
  return {
    idx, spec,
    p: [0, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], L: [0, 0, 0], w: [0, 0, 0],
    R: new Array(9).fill(0), Iw: new Array(9).fill(0),
    state: 'ready', // ready | spin | down | out | burst
    finish: null,
    lockLoad: 0, lockU: 0,
    scrapeT: 0, onRail: false, lastPocket: null,
    // 描画・表示用
    x: 0, y: 0, z: 0, ax: 0, az: 0, axis: [0, 1, 0], spin: 0, speed: 0, tilt: 0,
  };
}

// q ← exp(ω dt) q
function rotateBy(q, w, dt, out) {
  const wm = Math.hypot(w[0], w[1], w[2]);
  if (wm < 1e-12) {
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3];
    return out;
  }
  const ang = wm * dt;
  const s = Math.sin(ang / 2) / wm;
  const dx = w[0] * s, dy = w[1] * s, dz = w[2] * s, dw = Math.cos(ang / 2);
  const nx = dw * q[0] + dx * q[3] + dy * q[2] - dz * q[1];
  const ny = dw * q[1] - dx * q[2] + dy * q[3] + dz * q[0];
  const nz = dw * q[2] + dx * q[1] - dy * q[0] + dz * q[3];
  const nw = dw * q[3] - dx * q[0] - dy * q[1] - dz * q[2];
  const n = Math.hypot(nx, ny, nz, nw);
  out[0] = nx / n; out[1] = ny / n; out[2] = nz / n; out[3] = nw / n;
  return out;
}

// 姿勢の更新は中点法: 半歩回した姿勢での ω = I⁻¹ L を使う（角運動量は保存したまま）。
// 単純な前進オイラーだと高速回転で章動がふくらんでしまう
const qHalf = [0, 0, 0, 1];
function rotate(b, dt) {
  const q0 = b.q.slice();
  let w = b.w.slice();
  for (let it = 0; it < 2; it++) {
    rotateBy(q0, w, dt / 2, qHalf);
    b.q[0] = qHalf[0]; b.q[1] = qHalf[1]; b.q[2] = qHalf[2]; b.q[3] = qHalf[3];
    refresh(b);
    w = b.w.slice();
  }
  rotateBy(q0, w, dt, b.q);
}

// 姿勢から世界座標の逆慣性テンソルと角速度を更新
const T9 = new Array(9);
function refresh(b) {
  qMat(b.q, b.R);
  const R = b.R;
  const Ii = b.spec.Iinv;
  // Iw = R Ii Rᵀ
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      T9[i * 3 + j] = R[i * 3] * Ii[j] + R[i * 3 + 1] * Ii[3 + j] + R[i * 3 + 2] * Ii[6 + j];
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      b.Iw[i * 3 + j] = T9[i * 3] * R[j * 3] + T9[i * 3 + 1] * R[j * 3 + 1] + T9[i * 3 + 2] * R[j * 3 + 2];
    }
  }
  const I = b.Iw;
  const L = b.L;
  b.w[0] = I[0] * L[0] + I[1] * L[1] + I[2] * L[2];
  b.w[1] = I[3] * L[0] + I[4] * L[1] + I[5] * L[2];
  b.w[2] = I[6] * L[0] + I[7] * L[1] + I[8] * L[2];
}

// パーツ座標の点 → 世界座標
function toWorld(b, x, y, z, out) {
  const c = b.spec.com;
  const R = b.R;
  const lx = x - c[0], ly = y - c[1], lz = z - c[2];
  out[0] = b.p[0] + R[0] * lx + R[1] * ly + R[2] * lz;
  out[1] = b.p[1] + R[3] * lx + R[4] * ly + R[5] * lz;
  out[2] = b.p[2] + R[6] * lx + R[7] * ly + R[8] * lz;
  return out;
}

// 世界座標の点 → パーツ座標
function toPart(b, x, y, z, out) {
  const c = b.spec.com;
  const R = b.R;
  const dx = x - b.p[0], dy = y - b.p[1], dz = z - b.p[2];
  out[0] = R[0] * dx + R[3] * dy + R[6] * dz + c[0];
  out[1] = R[1] * dx + R[4] * dy + R[7] * dz + c[1];
  out[2] = R[2] * dx + R[5] * dy + R[8] * dz + c[2];
  return out;
}

function axisOf(b, out) {
  out[0] = b.R[1]; out[1] = b.R[4]; out[2] = b.R[7];
  return out;
}

// power: 0..1, angle: 打ち出し方向 atan2(z,x), bank: 傾けシュート
export function launch(world, idx, { x, z, angle, power, bank = 0 }) {
  const b = world.beys[idx];
  const sp = b.spec;
  const rng = world.rng;
  const pw = Math.max(0.05, Math.min(1, power));
  const quality = 0.95 + rng() * 0.06;
  // 傾けシュート: 進行方向の横を軸に倒す
  const tilt = 0.01 + bank * 0.14;
  const hx = Math.cos(angle + Math.PI / 2);
  const hz = Math.sin(angle + Math.PI / 2);
  const s = Math.sin(tilt / 2);
  b.q = [hx * s, 0, hz * s, Math.cos(tilt / 2)];
  refresh(b);
  // 軸先の最下点が床から 3mm 上になるように置く
  const tipW = [0, 0, 0];
  b.p = [x, 0, z];
  toWorld(b, 0, 0, 0, tipW);
  b.p[1] += floorY(x, z, world.st) + 0.003 - tipW[1];
  const speed = (0.2 + 0.9 * pw) * quality;
  b.v = [Math.cos(angle) * speed, -0.05, Math.sin(angle) * speed];
  const wmag = sp.spinSign * (520 + 430 * pw) * quality;
  const axis = axisOf(b, [0, 0, 0]);
  // L = I_world ω
  const Iw = inv3(b.Iw);
  const w = [axis[0] * wmag, axis[1] * wmag, axis[2] * wmag];
  b.L = [
    Iw[0] * w[0] + Iw[1] * w[1] + Iw[2] * w[2],
    Iw[3] * w[0] + Iw[4] * w[1] + Iw[5] * w[2],
    Iw[6] * w[0] + Iw[7] * w[1] + Iw[8] * w[2],
  ];
  refresh(b);
  b.state = 'spin';
  b.finish = null;
  b.lockLoad = 0;
  b.scrapeT = 0;
  b.w0 = Math.abs(wmag);
  updateView(b);
}

function emit(world, ev) {
  ev.t = world.t;
  world.events.push(ev);
}

const live = (b) => b.state === 'spin' || b.state === 'down' || b.state === 'out';

// ---------------- 時間を進める ----------------

// 時間 T だけ進める（刻み幅は状況に応じて自動で細かくする）
export function advance(world, T) {
  let left = T;
  let guard = 0;
  while (left > 1e-9 && guard++ < 200000) {
    const dt = Math.min(left, chooseDt(world));
    step(world, dt);
    left -= dt;
  }
}

// 輪郭どうし・輪郭と壁が当たりそうなときは、刃の先が1歩で動く距離が 0.7mm 以下になるよう細かく刻む
function chooseDt(world) {
  const st = world.st;
  let near = false;
  let speed = 0.5;
  const bs = world.beys;
  for (const b of bs) {
    if (!live(b)) continue;
    const wm = Math.hypot(b.w[0], b.w[1], b.w[2]);
    speed = Math.max(speed, wm * b.spec.rmax + Math.hypot(b.v[0], b.v[2]));
    if (Math.hypot(b.p[0], b.p[2]) + b.spec.rmax > st.R - 0.004) near = true;
  }
  if (bs.length === 2 && live(bs[0]) && live(bs[1])) {
    const d = Math.hypot(bs[0].p[0] - bs[1].p[0], bs[0].p[2] - bs[1].p[2]);
    if (d < bs[0].spec.rmax + bs[1].spec.rmax + 0.005) near = true;
  }
  if (!near) return DT_COARSE;
  return Math.max(DT_FINE_MIN, Math.min(DT_SOFT, 0.0007 / speed));
}

const tmpA = [0, 0, 0];
const tmpB = [0, 0, 0];
const tmpN = [0, 0, 0];

export function step(world, dt) {
  world.t += dt;
  const bs = world.beys;
  for (const b of bs) {
    if (!live(b)) continue;
    b.v[1] -= G * dt;
    // 空気抵抗トルク
    const wm = Math.hypot(b.w[0], b.w[1], b.w[2]);
    const k = b.spec.air * wm * dt;
    b.L[0] -= k * b.w[0];
    b.L[1] -= k * b.w[1];
    b.L[2] -= k * b.w[2];
    refresh(b);
    b.lockU = 0;
    b.onRail = false;
    b.scraping = false;
  }

  const cs = (world.contacts = []);
  for (const b of bs) {
    if (!live(b)) continue;
    tipContacts(world, b, cs);
    rimFloorContacts(world, b, cs);
    wallContacts(world, b, cs);
    ceilingContacts(world, b, cs);
    railContacts(world, b, cs, dt);
  }
  if (bs.length === 2 && live(bs[0]) && live(bs[1])) {
    pairContacts(world, bs[0], bs[1], cs);
    pairContacts(world, bs[1], bs[0], cs);
  }

  const soft = cs.filter((c) => c.soft);
  const rigid = cs.filter((c) => !c.soft);
  softForces(soft, dt);
  solve(rigid);
  afterSolve(world, cs, dt);

  // 積分
  for (const b of bs) {
    if (!live(b)) continue;
    b.p[0] += b.v[0] * dt;
    b.p[1] += b.v[1] * dt;
    b.p[2] += b.v[2] * dt;
    rotate(b, dt);
  }
  // めり込みの解消（位置だけ動かす。柔らかい接触はばねが押し返すので対象外）
  for (const c of rigid) {
    const pen = c.pen - SLOP;
    if (pen <= 0) continue;
    const ia = 1 / c.a.spec.m;
    const ib = c.b ? 1 / c.b.spec.m : 0;
    const k = (pen * 0.5) / (ia + ib);
    c.a.p[0] += c.nx * k * ia; c.a.p[1] += c.ny * k * ia; c.a.p[2] += c.nz * k * ia;
    if (c.b) {
      c.b.p[0] -= c.nx * k * ib; c.b.p[1] -= c.ny * k * ib; c.b.p[2] -= c.nz * k * ib;
    }
  }
  for (const b of bs) {
    if (!live(b)) continue;
    refresh(b);
    checkState(world, b, dt);
    updateView(b);
  }
}

// ---------------- 接触の検出 ----------------

function addContact(cs, a, b, px, py, pz, nx, ny, nz, pen, e, mu, extra) {
  const c = {
    a, b, px, py, pz, nx, ny, nz, pen: Math.max(0, pen), e, mu,
    jn: 0, jtx: 0, jty: 0, jtz: 0, jtor: 0, tcap: Infinity, torsion: 0, kind: 'floor', partA: null, partB: null,
  };
  if (extra) Object.assign(c, extra);
  cs.push(c);
  return c;
}

// 軸先と床。平らな軸先は「圧力中心」1点で表す: 床に対してまっすぐ立っていれば中心（ねじり摩擦の腕は
// 一様な圧力の 2/3·a）、傾くほど低い側の縁へ移る。移り切る角度は接触面の弾性変形で決まる（TIP_FLEX）
function tipContacts(world, b, cs) {
  const tip = b.spec.tip;
  const ctr = toWorld(b, 0, tip.rr, 0, tmpA); // 円板の中心
  const n = floorNormal(ctr[0], ctr[2], tmpN, world.st);
  const nx = n[0], ny = n[1], nz = n[2];
  let bx = ctr[0], by = ctr[1], bz = ctr[2];
  let torsion = tip.torsion;
  if (tip.a > 0) {
    // 床の法線を円板の面に投影した向きの逆が、いちばん低い縁の方向
    const ax = b.R[1], ay = b.R[4], az = b.R[7];
    const dn = nx * ax + ny * ay + nz * az;
    let lx = -(nx - dn * ax), ly = -(ny - dn * ay), lz = -(nz - dn * az);
    const sinT = Math.hypot(lx, ly, lz);
    const f = Math.min(1, Math.asin(Math.min(1, sinT)) / tip.flex);
    if (sinT > 1e-9) {
      lx /= sinT; ly /= sinT; lz /= sinT;
      bx += lx * tip.a * f; by += ly * tip.a * f; bz += lz * tip.a * f;
    }
    torsion = (2 / 3) * tip.a * (1 - f) + tip.torsion;
  }
  const px = bx - tip.rr * nx;
  const py = by - tip.rr * ny;
  const pz = bz - tip.rr * nz;
  const pen = (floorY(px, pz, world.st) - py) * ny;
  if (pen > -SLOP) addContact(cs, b, null, px, py, pz, nx, ny, nz, pen, tip.e, tip.mu, { torsion, kind: 'tip' });
}

// 下面の縁が床をこする（倒れかけ・倒れたとき）
function rimFloorContacts(world, b, cs) {
  const sp = b.spec;
  const ax = axisOf(b, tmpB);
  const sinTilt = Math.hypot(ax[0], ax[2]);
  for (const L of sp.layers) {
    const c = toWorld(b, 0, L.y0, 0, tmpA);
    const fy = floorY(c[0], c[2], world.st);
    // ざっくりした下限: 縁は中心より rmax·sin(傾き) 低く、床は斜面のぶん高い可能性がある
    if (c[1] - L.table.rmax * (sinTilt + 0.6) > fy + 0.002) continue;
    let best = null;
    for (let i = 0; i < 16; i++) {
      const k = Math.round((i / 16) * NPOLAR) % NPOLAR;
      const phi = k * DPHI;
      const r = L.table.R[k];
      const p = toWorld(b, Math.cos(phi) * r, L.y0, Math.sin(phi) * r, [0, 0, 0]);
      const pen = floorY(p[0], p[2], world.st) - p[1];
      if (!best || pen > best.pen) best = { p, pen };
    }
    if (best && best.pen > -SLOP) {
      const n = floorNormal(best.p[0], best.p[2], [0, 0, 0], world.st);
      addContact(cs, b, null, best.p[0], best.p[1], best.p[2], n[0], n[1], n[2], best.pen * n[1], 0.2,
        (L.mat.mu + MATERIALS.plastic.mu) / 2, { kind: 'scrape', partA: L.part });
      b.scraping = true;
    }
  }
}

// 輪郭のうち、パーツ座標の方向 φu にいちばん張り出している点
function extremePoint(table, phiU, win) {
  const k0 = Math.round(phiU / DPHI);
  const kw = Math.round(win / DPHI);
  let best = -1;
  let bk = 0;
  for (let j = -kw; j <= kw; j++) {
    const k = (((k0 + j) % NPOLAR) + NPOLAR) % NPOLAR;
    const v = table.R[k] * Math.cos(k * DPHI - phiU);
    if (v > best) {
      best = v;
      bk = k;
    }
  }
  return bk;
}

function wallContacts(world, b, cs) {
  const st = world.st;
  const sp = b.spec;
  const r = Math.hypot(b.p[0], b.p[2]);
  if (r + sp.rmax < st.R - 0.002 || r < 1e-6) return;
  const ux = b.p[0] / r;
  const uz = b.p[2] / r;
  // 外向き方向をパーツ座標へ
  const R = b.R;
  const lx = R[0] * ux + R[6] * uz;
  const lz = R[2] * ux + R[8] * uz;
  const phiU = Math.atan2(lz, lx);
  const openTop = bowlY(st.R, st) + st.pocketTop;
  for (const L of sp.layers) {
    const k = extremePoint(L.table, phiU, 0.6);
    const phi = k * DPHI;
    const rr = L.table.R[k];
    const cx = Math.cos(phi) * rr;
    const cz = Math.sin(phi) * rr;
    let best = null;
    for (const y of [L.y0, L.y1]) {
      const p = toWorld(b, cx, y, cz, [0, 0, 0]);
      const pr = Math.hypot(p[0], p[2]);
      const pen = pr - st.R;
      // ポケットの開口（床から pocketTop まで）以外はカバーの高さまで壁
      const open = p[1] < openTop && pocketAt(Math.atan2(p[2], p[0]), st);
      if (pen > -SLOP && pen < 0.01 && !open && (!best || pen > best.pen)) best = { p, pen, pr };
    }
    if (best) {
      const nx = -best.p[0] / best.pr;
      const nz = -best.p[2] / best.pr;
      addContact(cs, b, null, best.p[0], best.p[1], best.p[2], nx, 0, nz, best.pen,
        (L.mat.e + MATERIALS.plastic.e) / 2, (L.mat.mu + MATERIALS.plastic.mu) / 2, { kind: 'wall', partA: L.part, soft: true });
    }
  }
}

// 透明カバー: ブレードの上面の縁が当たる
function ceilingContacts(world, b, cs) {
  const st = world.st;
  const L = b.spec.layers[0];
  const c = toWorld(b, 0, L.y1, 0, tmpA);
  if (c[1] + L.table.rmax < st.ceiling - 0.002) return;
  let best = null;
  for (let i = 0; i < 16; i++) {
    const k = Math.round((i / 16) * NPOLAR) % NPOLAR;
    const phi = k * DPHI;
    const r = L.table.R[k];
    const p = toWorld(b, Math.cos(phi) * r, L.y1, Math.sin(phi) * r, [0, 0, 0]);
    if (!best || p[1] > best[1]) best = p;
  }
  const pen = best[1] - st.ceiling;
  if (pen > -SLOP) addContact(cs, b, null, best[0], best[1], best[2], 0, -1, 0, pen, 0.4, 0.26, { kind: 'ceiling', soft: true });
}

// ギアとレールの段差。歯の噛み合いを高い摩擦で表し、半クラッチのトルクで頭打ちにする
function railContacts(world, b, cs, dt) {
  const st = world.st;
  const sp = b.spec;
  const g = toWorld(b, 0, (sp.gear.y0 + sp.gear.y1) / 2, 0, tmpA);
  const r = Math.hypot(g[0], g[2]);
  if (r < st.rail.r - st.rail.notchDepth - 0.02) return;
  const phi = Math.atan2(g[2], g[0]);
  const rho = railRadius(phi, st);
  const d = r - rho;
  const face = st.rail.w * 0.6;
  const reach = GEAR_R + face;
  if (Math.abs(d) > reach) return;
  // ギアの下端がレールの上端より低いときだけ当たる
  const gb = toWorld(b, 0, sp.gear.y0, 0, tmpB);
  if (gb[1] > bowlY(rho, st) + st.rail.h) return;
  // レールの中心線までの距離の勾配（射出ポイントでは内側に曲がっている）
  const e = 0.0005;
  const dd = (x, z) => Math.hypot(x, z) - railRadius(Math.atan2(z, x), st);
  let gx = (dd(g[0] + e, g[2]) - dd(g[0] - e, g[2])) / (2 * e);
  let gz = (dd(g[0], g[2] + e) - dd(g[0], g[2] - e)) / (2 * e);
  const gm = Math.hypot(gx, gz) || 1;
  gx /= gm;
  gz /= gm;
  const side = d < 0 ? -1 : 1; // 内側にいるなら内向きに押し返す
  const nx = gx * side;
  const nz = gz * side;
  const pen = reach - Math.abs(d);
  // 歯は縦の溝なので、摩擦（噛み合い）はレールに沿った水平方向だけに働く
  addContact(cs, b, null, g[0] - nx * GEAR_R, g[1], g[2] - nz * GEAR_R, nx, 0, nz, pen, 0, 1.0, {
    kind: 'rail', tcap: (sp.gear.clutch * dt) / GEAR_R, tdir: [-nz, 0, nx],
  });
}

// X の輪郭の点が Y の輪郭に入り込んでいるか（X → Y の片方向）
const pP = [0, 0, 0];
const pW = [0, 0, 0];
const pY = [0, 0, 0];
function pairContacts(world, X, Y, cs) {
  const sx = X.spec;
  const sy = Y.spec;
  const dxw = Y.p[0] - X.p[0];
  const dzw = Y.p[2] - X.p[2];
  const dist = Math.hypot(dxw, dzw);
  if (dist > sx.rmax + sy.rmax + 0.001) return;
  // Y の方向を X のパーツ座標で
  const R = X.R;
  const lx = R[0] * dxw + R[6] * dzw;
  const lz = R[2] * dxw + R[8] * dzw;
  const phi0 = Math.atan2(lz, lx);
  const cw = (dist * dist + sx.rmax * sx.rmax - sy.rmax * sy.rmax) / (2 * Math.max(dist, 1e-6) * sx.rmax);
  const win = Math.acos(Math.max(-1, Math.min(1, cw))) + 0.06;
  const kw = Math.min(NPOLAR / 2, Math.ceil(win / DPHI));
  const k0 = Math.round(phi0 / DPHI);
  for (const LX of sx.layers) {
    for (const LY of sy.layers) {
      let best = null;
      for (let j = -kw; j <= kw; j += 2) {
        const k = (((k0 + j) % NPOLAR) + NPOLAR) % NPOLAR;
        const ph = k * DPHI;
        const rr = LX.table.R[k];
        const cx = Math.cos(ph) * rr;
        const cz = Math.sin(ph) * rr;
        // X の帯の上下端を Y の座標へ移し、重なる高さの中央で判定
        toWorld(X, cx, LX.y0, cz, pW);
        toPart(Y, pW[0], pW[1], pW[2], pY);
        const ya = pY[1];
        toWorld(X, cx, LX.y1, cz, pW);
        toPart(Y, pW[0], pW[1], pW[2], pP);
        const yb = pP[1];
        const lo = Math.max(Math.min(ya, yb), LY.y0);
        const hi = Math.min(Math.max(ya, yb), LY.y1);
        if (hi <= lo) continue;
        const f = ((lo + hi) / 2 - ya) / (yb - ya || 1e-9);
        const px = pY[0] + (pP[0] - pY[0]) * f;
        const pz = pY[2] + (pP[2] - pY[2]) * f;
        const rho = Math.hypot(px, pz);
        if (rho > LY.table.rmax) continue;
        let a = Math.atan2(pz, px);
        if (a < 0) a += TAU;
        const ky = Math.round(a / DPHI) % NPOLAR;
        const Rk = LY.table.R[ky];
        if (rho >= Rk || Rk - rho > 0.006) continue;
        const cosn = (LY.table.nx[ky] * px + LY.table.nz[ky] * pz) / (rho || 1e-9);
        const pen = (Rk - rho) * Math.max(0.2, cosn);
        if (!best || pen > best.pen) best = { pen, ky, cx, cz, yx: LX.y0 + (LX.y1 - LX.y0) * f };
      }
      if (!best) continue;
      // 接点（X の輪郭上の点）と、Y の面の外向き法線（世界座標）
      const p = toWorld(X, best.cx, best.yx, best.cz, [0, 0, 0]);
      const RY = Y.R;
      const tnx = LY.table.nx[best.ky];
      const tnz = LY.table.nz[best.ky];
      const nx = RY[0] * tnx + RY[2] * tnz;
      const ny = RY[3] * tnx + RY[5] * tnz;
      const nz = RY[6] * tnx + RY[8] * tnz;
      addContact(cs, X, Y, p[0], p[1], p[2], nx, ny, nz, best.pen, (LX.mat.e + LY.mat.e) / 2, (LX.mat.mu + LY.mat.mu) / 2,
        { kind: 'pair', partA: LX.part, partB: LY.part, soft: true });
    }
  }
}

// ---------------- 柔らかい接触（ばね＋減衰＋クーロン摩擦） ----------------

function vr0(c) {
  const v = relVel(c, [0, 0, 0]);
  return v[0] * c.nx + v[1] * c.ny + v[2] * c.nz;
}

function softForces(cs, dt) {
  const vr = [0, 0, 0];
  for (const c of cs) {
    c.rax = c.px - c.a.p[0]; c.ray = c.py - c.a.p[1]; c.raz = c.pz - c.a.p[2];
    if (c.b) {
      c.rbx = c.px - c.b.p[0]; c.rby = c.py - c.b.p[1]; c.rbz = c.pz - c.b.p[2];
    }
    const kn = kAlong(c.a, c.rax, c.ray, c.raz, c.nx, c.ny, c.nz) + (c.b ? kAlong(c.b, c.rbx, c.rby, c.rbz, c.nx, c.ny, c.nz) : 0);
    const mEff = 1 / kn;
    // 反発係数から減衰比を決める: ζ = -ln e / √(π² + ln² e)
    // 衝突速度が速いほど反発係数は下がる（塑性変形）
    const vin = Math.max(E_YIELD_V, -(vr0(c) || 0));
    const le = Math.log(Math.max(0.05, c.e * Math.pow(E_YIELD_V / vin, 0.25)));
    const zeta = -le / Math.sqrt(Math.PI * Math.PI + le * le);
    const damp = 2 * zeta * Math.sqrt(K_SOFT * mEff);
    relVel(c, vr);
    const vn = vr[0] * c.nx + vr[1] * c.ny + vr[2] * c.nz;
    c.vn0 = vn;
    const Fn = Math.max(0, K_SOFT * c.pen - damp * vn);
    if (Fn <= 0) continue;
    const jn = Fn * dt;
    // 摩擦: すべりと逆向きに μ Fn。ただし1歩ですべりを逆転させない
    const tx = vr[0] - vn * c.nx;
    const ty = vr[1] - vn * c.ny;
    const tz = vr[2] - vn * c.nz;
    const vt = Math.hypot(tx, ty, tz);
    let jtx = 0, jty = 0, jtz = 0;
    if (vt > 1e-9) {
      const ux = tx / vt, uy = ty / vt, uz = tz / vt;
      const kt = kAlong(c.a, c.rax, c.ray, c.raz, ux, uy, uz) + (c.b ? kAlong(c.b, c.rbx, c.rby, c.rbz, ux, uy, uz) : 0);
      const jt = Math.min(c.mu * jn * Math.min(1, vt / V_SLIP), vt / kt);
      jtx = -ux * jt; jty = -uy * jt; jtz = -uz * jt;
    }
    c.jn = jn;
    c.jtx = jtx; c.jty = jty; c.jtz = jtz;
    push(c, c.nx * jn + jtx, c.ny * jn + jty, c.nz * jn + jtz);
  }
}

// ---------------- 撃力の解決（逐次インパルス法） ----------------

function velAt(b, rx, ry, rz, out) {
  const w = b.w;
  out[0] = b.v[0] + w[1] * rz - w[2] * ry;
  out[1] = b.v[1] + w[2] * rx - w[0] * rz;
  out[2] = b.v[2] + w[0] * ry - w[1] * rx;
  return out;
}

// 方向 d に単位撃力を加えたときの、その点の d 方向の速度変化（有効質量の逆数）
function kAlong(b, rx, ry, rz, dx, dy, dz) {
  const cx = ry * dz - rz * dy;
  const cy = rz * dx - rx * dz;
  const cz = rx * dy - ry * dx;
  const I = b.Iw;
  const ix = I[0] * cx + I[1] * cy + I[2] * cz;
  const iy = I[3] * cx + I[4] * cy + I[5] * cz;
  const iz = I[6] * cx + I[7] * cy + I[8] * cz;
  const tx = iy * rz - iz * ry;
  const ty = iz * rx - ix * rz;
  const tz = ix * ry - iy * rx;
  return 1 / b.spec.m + tx * dx + ty * dy + tz * dz;
}

function syncW(b) {
  const I = b.Iw;
  const L = b.L;
  b.w[0] = I[0] * L[0] + I[1] * L[1] + I[2] * L[2];
  b.w[1] = I[3] * L[0] + I[4] * L[1] + I[5] * L[2];
  b.w[2] = I[6] * L[0] + I[7] * L[1] + I[8] * L[2];
}

function applyImpulse(b, rx, ry, rz, jx, jy, jz) {
  const im = 1 / b.spec.m;
  b.v[0] += jx * im;
  b.v[1] += jy * im;
  b.v[2] += jz * im;
  b.L[0] += ry * jz - rz * jy;
  b.L[1] += rz * jx - rx * jz;
  b.L[2] += rx * jy - ry * jx;
  syncW(b);
}

const va = [0, 0, 0];
const vb = [0, 0, 0];
function relVel(c, out) {
  velAt(c.a, c.rax, c.ray, c.raz, va);
  if (c.b) {
    velAt(c.b, c.rbx, c.rby, c.rbz, vb);
    out[0] = va[0] - vb[0]; out[1] = va[1] - vb[1]; out[2] = va[2] - vb[2];
  } else {
    out[0] = va[0]; out[1] = va[1]; out[2] = va[2];
  }
  return out;
}

function push(c, jx, jy, jz) {
  applyImpulse(c.a, c.rax, c.ray, c.raz, jx, jy, jz);
  if (c.b) applyImpulse(c.b, c.rbx, c.rby, c.rbz, -jx, -jy, -jz);
}

function solve(cs) {
  const vr = [0, 0, 0];
  for (const c of cs) {
    c.rax = c.px - c.a.p[0]; c.ray = c.py - c.a.p[1]; c.raz = c.pz - c.a.p[2];
    if (c.b) {
      c.rbx = c.px - c.b.p[0]; c.rby = c.py - c.b.p[1]; c.rbz = c.pz - c.b.p[2];
    }
    c.kn = kAlong(c.a, c.rax, c.ray, c.raz, c.nx, c.ny, c.nz) + (c.b ? kAlong(c.b, c.rbx, c.rby, c.rbz, c.nx, c.ny, c.nz) : 0);
    relVel(c, vr);
    const vn = vr[0] * c.nx + vr[1] * c.ny + vr[2] * c.nz;
    c.vn0 = vn;
    // 反発係数は衝突速度が上がるほど下がる（塑性変形）: e = e0 · min(1, (v_y / v)^¼)
    c.target = vn < -0.04 ? -c.e * Math.min(1, Math.pow(E_YIELD_V / -vn, 0.25)) * vn : 0;
    if (c.torsion > 0) {
      const I = c.a.Iw;
      c.ktor = c.nx * (I[0] * c.nx + I[1] * c.ny + I[2] * c.nz) + c.ny * (I[3] * c.nx + I[4] * c.ny + I[5] * c.nz)
        + c.nz * (I[6] * c.nx + I[7] * c.ny + I[8] * c.nz);
    }
  }
  for (let it = 0; it < ITER; it++) {
    for (const c of cs) {
      // 法線方向
      relVel(c, vr);
      let vn = vr[0] * c.nx + vr[1] * c.ny + vr[2] * c.nz;
      let dj = (c.target - vn) / c.kn;
      const jn = Math.max(0, c.jn + dj);
      dj = jn - c.jn;
      c.jn = jn;
      if (dj !== 0) push(c, c.nx * dj, c.ny * dj, c.nz * dj);
      // 摩擦（接線方向。クーロンの円錐と、レールなら半クラッチの上限で頭打ち）
      relVel(c, vr);
      vn = vr[0] * c.nx + vr[1] * c.ny + vr[2] * c.nz;
      let tx = vr[0] - vn * c.nx;
      let ty = vr[1] - vn * c.ny;
      let tz = vr[2] - vn * c.nz;
      if (c.tdir) {
        // 摩擦の向きが決まっている接触（レール）
        const d = tx * c.tdir[0] + ty * c.tdir[1] + tz * c.tdir[2];
        tx = c.tdir[0] * d; ty = c.tdir[1] * d; tz = c.tdir[2] * d;
      }
      const vt = Math.hypot(tx, ty, tz);
      if (vt > 1e-9) {
        const ux = tx / vt, uy = ty / vt, uz = tz / vt;
        const kt = kAlong(c.a, c.rax, c.ray, c.raz, ux, uy, uz) + (c.b ? kAlong(c.b, c.rbx, c.rby, c.rbz, ux, uy, uz) : 0);
        const d = -vt / kt;
        let nx = c.jtx + ux * d;
        let ny = c.jty + uy * d;
        let nz = c.jtz + uz * d;
        const lim = Math.min(c.mu * c.jn, c.tcap);
        const m = Math.hypot(nx, ny, nz);
        if (m > lim) {
          const s = lim / m;
          nx *= s; ny *= s; nz *= s;
        }
        const ddx = nx - c.jtx, ddy = ny - c.jty, ddz = nz - c.jtz;
        c.jtx = nx; c.jty = ny; c.jtz = nz;
        push(c, ddx, ddy, ddz);
      }
      // ねじり摩擦（点接触の接触円）
      if (c.torsion > 0 && c.ktor > 0) {
        const wn = c.a.w[0] * c.nx + c.a.w[1] * c.ny + c.a.w[2] * c.nz;
        let nt = c.jtor - wn / c.ktor;
        const lim = c.torsion * c.mu * c.jn;
        nt = Math.max(-lim, Math.min(lim, nt));
        const d = nt - c.jtor;
        c.jtor = nt;
        c.a.L[0] += c.nx * d;
        c.a.L[1] += c.ny * d;
        c.a.L[2] += c.nz * d;
        syncW(c.a);
      }
    }
  }
}

// ---------------- 撃力のあと: バースト・イベント ----------------

function lockShare(b, part, jx, jy, jz, rx, ry, rz) {
  // 叩かれたことによる軸まわりの角力積
  const ax = axisOf(b, tmpB);
  const dL = (ry * jz - rz * jy) * ax[0] + (rz * jx - rx * jz) * ax[1] + (rx * jy - ry * jx) * ax[2];
  const wa = b.w[0] * ax[0] + b.w[1] * ax[1] + b.w[2] * ax[2];
  const sp = b.spec;
  if (part === 'blade') {
    // 上層が回転方向へ押されたときだけ、コアとの間でロックが回る（コアの慣性の割合）
    return dL * wa > 0 ? Math.abs(dL) * (sp.IcoreAxis / sp.IaxisTotal) : 0;
  }
  // 中層・下層が回転を止める向きに叩かれると、ブレードが慣性で回り続けてロックが回る
  return dL * wa < 0 ? Math.abs(dL) * (sp.IbladeAxis / sp.IaxisTotal) : 0;
}

function afterSolve(world, cs, dt) {
  let pairJ = 0;
  let deepest = null;
  const wallNow = new Set();
  for (const c of cs) {
    const jx = c.nx * c.jn + c.jtx;
    const jy = c.ny * c.jn + c.jty;
    const jz = c.nz * c.jn + c.jtz;
    if (c.kind === 'pair') {
      if (c.jn <= 0) continue;
      c.a.lockU += lockShare(c.a, c.partA, jx, jy, jz, c.rax, c.ray, c.raz);
      c.b.lockU += lockShare(c.b, c.partB, -jx, -jy, -jz, c.rbx, c.rby, c.rbz);
      pairJ += Math.hypot(jx, jy, jz);
      if (!deepest || c.pen > deepest.pen) deepest = c;
    } else if (c.kind === 'rail') {
      // ギアが噛んで加速している（摩擦力が 0.05N 以上）
      if (Math.hypot(c.jtx, c.jty, c.jtz) > 0.05 * dt) c.a.onRail = true;
    } else if (c.kind === 'wall' && c.jn > 0) {
      wallNow.add(c.a);
      if (!c.a.wallTouch && c.vn0 < -0.3) emit(world, { type: 'wall', idx: c.a.idx, x: c.px, z: c.pz, strength: -c.vn0 * c.a.spec.m });
    }
  }
  for (const b of world.beys) b.wallTouch = wallNow.has(b);
  // コマどうしの当たり: 接触が続くあいだ力積を足し合わせ、離れたときに1回の当たりとして知らせる
  const H = world.hitAcc || (world.hitAcc = { j: 0, c: null, low: false });
  if (pairJ > 0) {
    H.j += pairJ;
    if (!H.c || deepest.pen > H.pen) {
      H.c = deepest;
      H.pen = deepest.pen;
    }
    if (deepest.partA !== 'blade' || deepest.partB !== 'blade') H.low = true;
  } else if (H.c) {
    const c = H.c;
    if (H.j > 0.002) {
      emit(world, {
        type: 'hit', x: c.px, y: c.py, z: c.pz, nx: c.nx, nz: c.nz, strength: H.j,
        same: Math.sign(c.a.spin) === Math.sign(c.b.spin), low: H.low,
      });
    }
    world.hitAcc = { j: 0, c: null, low: false };
  }
  // ロックの負荷（同時に分解するのは負荷の大きい方だけ）
  const order = world.beys.filter((b) => b.state === 'spin').sort((p, q) => q.lockU - p.lockU);
  let burstOne = false;
  for (const b of order) {
    const over = b.lockU - LOCK_HOLD * dt;
    if (over <= 0) continue;
    const before = Math.floor(b.lockLoad * LOCK_STEPS + 1e-9);
    b.lockLoad = Math.min(burstOne ? 0.999 : 1, b.lockLoad + over / b.spec.lockFull);
    const after = Math.floor(b.lockLoad * LOCK_STEPS + 1e-9);
    if (b.lockLoad >= 1) {
      b.state = 'burst';
      b.finish = 'burst';
      burstOne = true;
      emit(world, { type: 'burst', idx: b.idx, x: b.x, z: b.z, vx: b.v[0], vz: b.v[2], w: b.spin });
    } else if (after > before) emit(world, { type: 'lockstep', idx: b.idx, step: after });
    else emit(world, { type: 'strain', idx: b.idx, stress: over / b.spec.lockFull });
  }
}

function checkState(world, b, dt) {
  const st = world.st;
  // 自然回復は今いる段の区切りまで
  const floor = Math.floor(b.lockLoad * LOCK_STEPS + 1e-9) / LOCK_STEPS;
  b.lockLoad = Math.max(floor, b.lockLoad - LOCK_HEAL * dt);

  const r = Math.hypot(b.p[0], b.p[2]);
  const phi = Math.atan2(b.p[2], b.p[0]);
  if (r > st.R - 0.01) {
    const pk = pocketAt(phi, st);
    if (pk) b.lastPocket = pk;
  }
  if (b.state === 'spin' || b.state === 'down') {
    // ポケットの縁を越えて落ちた／壁を飛び越えた
    if ((r > st.R + 0.004 && b.p[1] < bowlY(st.R, st) - 0.01) || r > st.R + 0.03) {
      const pk = pocketAt(phi, st) || b.lastPocket;
      const wasDown = b.state === 'down';
      b.state = 'out';
      if (!wasDown) {
        b.finish = pk ? pk.type : 'over';
        emit(world, { type: b.finish, idx: b.idx, x: b.p[0], z: b.p[2] });
      }
      return;
    }
  }
  if (b.state === 'spin') {
    const ax = axisOf(b, tmpB);
    const spin = Math.abs(b.w[0] * ax[0] + b.w[1] * ax[1] + b.w[2] * ax[2]);
    b.scrapeT = b.scraping ? b.scrapeT + dt : Math.max(0, b.scrapeT - dt * 2);
    // 倒れた（下面の縁が床をこすり続けた）か、回転がほぼ止まった
    if (b.scrapeT > 0.25 || spin < 15 || ax[1] < 0.5) {
      b.state = 'down';
      b.finish = 'spin';
      emit(world, { type: 'down', idx: b.idx });
    }
  }
  if (b.p[1] < st.pit - 0.05 || !Number.isFinite(b.p[0])) {
    b.p = [b.p[0] || 0, st.pit, b.p[2] || 0];
    b.v = [0, 0, 0];
    b.L = [0, 0, 0];
    refresh(b);
  }
}

// 描画・表示用の値
function updateView(b) {
  const tip = toWorld(b, 0, 0, 0, tmpA);
  b.x = tip[0];
  b.y = tip[1];
  b.z = tip[2];
  const ax = axisOf(b, tmpB);
  b.ax = ax[0];
  b.az = ax[2];
  b.axis = [ax[0], ax[1], ax[2]];
  b.spin = b.w[0] * ax[0] + b.w[1] * ax[1] + b.w[2] * ax[2]; // 軸まわりの角速度（符号つき）
  b.speed = Math.hypot(b.v[0], b.v[2]);
  b.tilt = Math.acos(Math.max(-1, Math.min(1, ax[1])));
}

// ---------------- 判定 ----------------

export const POINTS = { spin: 1, over: 2, burst: 2, xtreme: 3 };

export function judge(world) {
  const [a, b] = world.beys;
  const doneA = a.finish !== null;
  const doneB = b.finish !== null;
  if (!doneA && !doneB) return null;
  if (doneA && doneB) {
    const pa = POINTS[a.finish];
    const pb = POINTS[b.finish];
    if (pa === pb) return { winner: -1, type: a.finish, points: 0 };
    return pa > pb ? { winner: 1, type: a.finish, points: pa } : { winner: 0, type: b.finish, points: pb };
  }
  const loser = doneA ? a : b;
  return { winner: doneA ? 1 : 0, type: loser.finish, points: POINTS[loser.finish] };
}

// ---------------- 単体で回したときの持続時間（表示用） ----------------

const soloCache = new Map();

// 少しずつ計算して画面を止めない。done になったら time が入る
export function soloRunner(spec) {
  const key = `${spec.blade.id}|${spec.ratchet.id}|${spec.bit.id}`;
  if (soloCache.has(key)) return { done: true, time: soloCache.get(key), run: () => true };
  const w = createBattle([spec], { seed: 7 });
  launch(w, 0, { x: -0.1, z: 0, angle: 0, power: 0.9 });
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const runner = {
    done: false,
    time: 0,
    run(budgetMs = 8) {
      if (runner.done) return true;
      const t0 = now();
      while (now() - t0 < budgetMs) {
        advance(w, 0.05);
        w.events.length = 0;
        if (w.beys[0].finish !== null || w.t > 200) {
          runner.done = true;
          runner.time = w.t;
          soloCache.set(key, w.t);
          return true;
        }
      }
      return false;
    },
  };
  return runner;
}

export function soloSpinTime(spec) {
  const r = soloRunner(spec);
  while (!r.run(1e9));
  return r.time;
}
