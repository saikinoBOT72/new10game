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
  // 壁の内半径。ギアがレールに噛む位置で、いちばん大きいブレードの縁と壁のあいだが約2mm（ギアがレールを越えられない）
  R: 0.187,
  wallH: 0.04,
  ceiling: 0.085, // 透明カバーの高さ（床の中心から）。壁はカバーまでつながっている
  pocketTop: 0.035, // ポケットの開口の高さ（壁の位置の床から）
  // 床の断面: 中央が低い皿形 y = curve r² で、外周に向かって上がり続け、その足元にレールがある
  curve: 0.45,
  // エクストリームライン: 外周の段差（ギアが噛む）。奥（-z）で内側に曲がり、射出ポイントになる
  rail: { r: 0.171, h: 0.0065, w: 0.0035, notchAt: deg(-90), notchDepth: 0.026, notchWidth: 0.22 },
  launch: { center: deg(-90), half: deg(14) },
  pockets: [
    // エクストリームゾーンは入口が高い。オーバーゾーンはなだらか
    { type: 'xtreme', center: deg(90), half: deg(15), lipLen: 0.012, lipH: 0.011 },
    { type: 'over', center: deg(38), half: deg(9), lipLen: 0.01, lipH: 0.0025 },
    { type: 'over', center: deg(142), half: deg(9), lipLen: 0.01, lipH: 0.0025 },
  ],
  // ポケットの左右では、壁とレールがなめらかに外へ開いてポケットの口につながる（角や段差の切れ端がない）。
  // 壁沿いに走ってきたコマはそのまま口へ導かれ、口を通り過ぎたコマは反対側の開きで内へ戻される
  flare: { len: deg(14), out: 0.014 },
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
// 剛体の撃力だと刃先の表面速度（秒速20m以上。壁に対しても ω·R·sinθ で迫る）の分の運動量が一瞬で全部受け渡されてしまうが、
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
  const x = Math.min(r, st.R);
  return st.curve * x * x;
}

export function pocketAt(phi, st = STADIUM) {
  for (const p of st.pockets) if (Math.abs(wrap(phi - p.center)) < p.half) return p;
  return null;
}

// ポケットの口への開き具合（口の縁で1、flare.len 離れると0。口の中も1）
export function pocketFlare(phi, st = STADIUM) {
  let f = 0;
  for (const p of st.pockets) {
    const d = Math.abs(wrap(phi - p.center)) - p.half;
    const s = d <= 0 ? 1 : Math.max(0, 1 - d / st.flare.len);
    f = Math.max(f, s * s * (3 - 2 * s)); // 両端で傾きが0になる曲線
  }
  return f;
}

export function wallRadius(phi, st = STADIUM) {
  return st.R + st.flare.out * pocketFlare(phi, st);
}

export function railRadius(phi, st = STADIUM) {
  const rl = st.rail;
  const d = wrap(phi - rl.notchAt) / rl.notchWidth;
  // ポケットの口の縁でレールの外側の面が壁に接するところまで外へ曲がる（レールの切れ端が口に突き出さない）
  const out = st.R + st.flare.out - rl.w / 2 - rl.r;
  return rl.r - rl.notchDepth * Math.exp(-d * d) + out * pocketFlare(phi, st);
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
    layerMass(ratT.R, 0.011, yr0, yr1, ratchet.m), // リングの内側はブレードの軸受けが入る空洞
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
      a: bit.a, rr: bit.rr, mu: tipMat.mu, e: 0.15,
      torsion: (3 * Math.PI / 16) * aHertz,
      flex: bit.tipMat === 'rubber' ? 0.03 : 0.005, // 圧力中心が縁まで移る傾き [rad]（ゴムは変形が大きい）
    },
    // ギアはビットの中ほど（ラチェット側のフランジのすぐ下）にある
    gear: { y0: bit.h * 0.45, y1: bit.h * 0.75, clutch: bit.clutch },
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
  // 傾けシュート（バンク）: 進行方向に対して横へ倒す。平らな軸先は低い側の縁で床をこすり、
  // その摩擦 −μN·(ω×ê の向き) が進行方向を向く側（回転の向きで決まる）へ倒すと、縁で転がるように走る
  const tilt = 0.01 + bank * 0.14;
  const ux = Math.cos(angle);
  const uz = Math.sin(angle);
  const s = Math.sin(tilt / 2);
  // 軸の上端を ê = spin·(ŷ × û) へ倒す回転（回転軸は −spin·û）
  b.q = [-sp.spinSign * ux * s, 0, -sp.spinSign * uz * s, Math.cos(tilt / 2)];
  refresh(b);
  // 軸先の最下点が床から 3mm 上になるように置く
  const tipW = [0, 0, 0];
  b.p = [x, 0, z];
  toWorld(b, 0, 0, 0, tipW);
  b.p[1] += floorY(x, z, world.st) + 0.003 - tipW[1];
  // 打ち出しの横向きの速さは引きの強さで大きく変わり、回転数はあまり変わらない
  // （実物でも、ひもを引く強さで回転が、打ち出す角度で横の動きが決まる）
  const speed = (0.1 + 1.4 * pw) * quality;
  b.v = [Math.cos(angle) * speed, -0.05, Math.sin(angle) * speed];
  // 回転数: 弱いシュートで約7,000rpm、全力で約10,000rpm（実物のランチャーの範囲）
  const wmag = sp.spinSign * (740 + 310 * pw) * quality;
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
  for (const c of rigid) if (c.patch) patchFriction(c);
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
  if (world.onStep) world.onStep(world, cs, dt);
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

// 平らな軸先の面を分けた点（単位円板の中。x, y と面積の重み）
const PATCH = (() => {
  const pts = [{ x: 0, y: 0, w: 0.04 }];
  const rings = [[0.3, 6], [0.6, 10], [0.88, 14]];
  let tot = 0.04;
  for (const [r, n] of rings) {
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU + r;
      const w = (r * 0.3) / n * 2 * Math.PI;
      pts.push({ x: Math.cos(th) * r, y: Math.sin(th) * r, w });
      tot += w;
    }
  }
  for (const p of pts) p.w /= tot;
  return pts;
})();

// 軸先と床。
// - 点の軸先（ボール・ニードル）は1点の接触で、転がりは撃力の摩擦、回転摩擦はヘルツ接触の接触円から。
// - 平らな軸先は面全体がすべりながら床をこする。床に対する傾きに応じて面の圧力が低い側へ偏り
//   （偏りきる角度は接触面の弾性変形 TIP_FLEX で決まる）、各点のすべり摩擦を圧力で重み付けして足し合わせる。
//   圧力が偏ると摩擦の合力が横向きに残り、これがコマを走らせる。ねじり摩擦もこの和から出る
function tipContacts(world, b, cs) {
  const tip = b.spec.tip;
  const ctr = toWorld(b, 0, tip.rr, 0, tmpA); // 円板の中心
  const n = floorNormal(ctr[0], ctr[2], tmpN, world.st);
  const nx = n[0], ny = n[1], nz = n[2];
  if (tip.a <= 0) {
    const px = ctr[0] - tip.rr * nx;
    const py = ctr[1] - tip.rr * ny;
    const pz = ctr[2] - tip.rr * nz;
    const pen = (floorY(px, pz, world.st) - py) * ny;
    if (pen > -SLOP) addContact(cs, b, null, px, py, pz, nx, ny, nz, pen, tip.e, tip.mu, { torsion: tip.torsion, kind: 'tip' });
    return;
  }
  // 床の法線を円板の面に投影した向きの逆が、いちばん低い縁の方向 ê
  const ax = b.R[1], ay = b.R[4], az = b.R[7];
  const dn = nx * ax + ny * ay + nz * az;
  let ex = -(nx - dn * ax), ey = -(ny - dn * ay), ez = -(nz - dn * az);
  const sinT = Math.hypot(ex, ey, ez);
  if (sinT > 1e-9) {
    ex /= sinT; ey /= sinT; ez /= sinT;
  } else {
    ex = b.R[0]; ey = b.R[3]; ez = b.R[6];
  }
  // ê2 = 軸 × ê
  const fx = ay * ez - az * ey, fy = az * ex - ax * ez, fz = ax * ey - ay * ex;
  // 圧力は ê 方向に線形に偏る p ∝ 1 + β x（負になった側は浮く）
  const s = Math.asin(Math.min(1, sinT)) / tip.flex;
  const beta = 4 * Math.min(s, 6);
  const a = tip.a;
  const samples = [];
  let wsum = 0;
  let dx = 0;
  for (const q of PATCH) {
    const w = q.w * Math.max(0, 1 + beta * q.x);
    if (w <= 0) continue;
    wsum += w;
    dx += w * q.x;
    samples.push({ q, w });
  }
  dx /= wsum;
  // 圧力中心に法線の接触を置く（摩擦はあとで面全体から）
  const cx = ctr[0] + ex * a * dx, cy = ctr[1] + ey * a * dx, cz = ctr[2] + ez * a * dx;
  const px = cx - tip.rr * nx;
  const py = cy - tip.rr * ny;
  const pz = cz - tip.rr * nz;
  const pen = (floorY(px, pz, world.st) - py) * ny;
  if (pen <= -SLOP) return;
  const pts = samples.map(({ q, w }) => [
    ctr[0] + (ex * q.x + fx * q.y) * a - tip.rr * nx,
    ctr[1] + (ey * q.x + fy * q.y) * a - tip.rr * ny,
    ctr[2] + (ez * q.x + fz * q.y) * a - tip.rr * nz,
    w / wsum,
  ]);
  addContact(cs, b, null, px, py, pz, nx, ny, nz, pen, tip.e, 0, { kind: 'tip', patch: pts, patchMu: tip.mu });
}

const V_EPS = 0.01; // すべり摩擦の向きを決める最小すべり速度 [m/s]
// 平らな軸先の面のすべり摩擦（法線の撃力 jn が決まってから）
function patchFriction(c) {
  const b = c.a;
  if (!c.patch || c.jn <= 0) return;
  const w = b.w;
  let Jx = 0, Jy = 0, Jz = 0, Lx = 0, Ly = 0, Lz = 0;
  for (const p of c.patch) {
    const rx = p[0] - b.p[0], ry = p[1] - b.p[1], rz = p[2] - b.p[2];
    let ux = b.v[0] + w[1] * rz - w[2] * ry;
    let uy = b.v[1] + w[2] * rx - w[0] * rz;
    let uz = b.v[2] + w[0] * ry - w[1] * rx;
    const un = ux * c.nx + uy * c.ny + uz * c.nz;
    ux -= un * c.nx; uy -= un * c.ny; uz -= un * c.nz;
    const um = Math.hypot(ux, uy, uz);
    if (um < 1e-12) continue;
    const k = (-c.patchMu * c.jn * p[3] * Math.min(1, um / V_EPS)) / um;
    const jx = ux * k, jy = uy * k, jz = uz * k;
    Jx += jx; Jy += jy; Jz += jz;
    Lx += ry * jz - rz * jy;
    Ly += rz * jx - rx * jz;
    Lz += rx * jy - ry * jx;
  }
  // 1歩で並進の速度を逆転させない（止まりかけのときの数値振動を防ぐ）。進行方向と逆向きの成分だけを頭打ちにする
  const vt = Math.hypot(b.v[0], b.v[1], b.v[2]);
  if (vt > 1e-9) {
    const vx = b.v[0] / vt, vy = b.v[1] / vt, vz = b.v[2] / vt;
    const back = -(Jx * vx + Jy * vy + Jz * vz);
    const lim = b.spec.m * vt;
    if (back > lim) {
      const d = back - lim;
      Jx += vx * d; Jy += vy * d; Jz += vz * d;
    }
  }
  b.v[0] += Jx / b.spec.m;
  b.v[1] += Jy / b.spec.m;
  b.v[2] += Jz / b.spec.m;
  b.L[0] += Lx; b.L[1] += Ly; b.L[2] += Lz;
  syncW(b);
  c.jtx = Jx; c.jty = Jy; c.jtz = Jz;
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
    // 床とは包絡線（最大半径の円）の下面の縁で当たる
    let best = null;
    const r = L.table.rmax;
    for (let i = 0; i < 16; i++) {
      const phi = (i / 16) * TAU;
      const p = toWorld(b, Math.cos(phi) * r, L.y0, Math.sin(phi) * r, [0, 0, 0]);
      const pen = floorY(p[0], p[2], world.st) - p[1];
      if (!best || pen > best.pen) best = { p, pen };
    }
    if (best && best.pen > -SLOP) {
      const n = floorNormal(best.p[0], best.p[2], [0, 0, 0], world.st);
      addContact(cs, b, null, best.p[0], best.p[1], best.p[2], n[0], n[1], n[2], best.pen * n[1], 0.2,
        L.mat.mu, { kind: 'scrape', partA: L.part });
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

// 壁: 半径 wallRadius(φ) の壁（ポケットの左右でなめらかに外へ開く）から、ポケットの口（床から pocketTop の高さまで）を
// 切り抜いた形。回転している輪郭の包絡線（最大半径の円）と当たる。刃先が壁の前を通り過ぎる周期（約3ms）と
// 壁がたわんで応答する時間が同じくらいなので、壁から見ると刃の凹凸はならされる。
// コマの軸からいちばん近い壁の点（壁の曲線の上か、口の縁）までの距離で判定する
const WALL_SAMPLES = 24;
function nearestWall(st, ax, az, rr, skipPockets) {
  const ar = Math.hypot(ax, az) || 1e-9;
  const phi0 = Math.atan2(az, ax);
  const W = (rr + 0.03) / st.R;
  let best = null;
  const test = (phi) => {
    if (skipPockets && pocketAt(phi, st)) return;
    const R = wallRadius(phi, st);
    const wx = Math.cos(phi) * R;
    const wz = Math.sin(phi) * R;
    const d = Math.hypot(ax - wx, az - wz);
    if (!best || d < best.d) best = { d, wx, wz, phi };
  };
  for (let i = 0; i <= WALL_SAMPLES; i++) test(phi0 - W + (2 * W * i) / WALL_SAMPLES);
  if (skipPockets) {
    // 口の縁（切り抜きの端）
    for (const p of st.pockets) {
      for (const e of [p.center - p.half - 1e-6, p.center + p.half + 1e-6]) if (Math.abs(wrap(e - phi0)) < W) test(e);
    }
  }
  if (!best) return null;
  // 近いところを細かく
  let h = W / WALL_SAMPLES;
  for (let k = 0; k < 6; k++) {
    const c = best.phi;
    test(c - h);
    test(c + h);
    h *= 0.5;
  }
  // 壁の外側にいる（口の中）ときは向きが逆になるので、壁の曲線の内向きの法線と比べて向きをそろえる
  let nx = (ax - best.wx) / (best.d || 1e-9);
  let nz = (az - best.wz) / (best.d || 1e-9);
  let dist = best.d;
  if (ar > wallRadius(phi0, st) && !(skipPockets && pocketAt(phi0, st))) {
    nx = -nx; nz = -nz; dist = -dist;
  }
  return { dist, wx: best.wx, wz: best.wz, nx, nz };
}

function wallContacts(world, b, cs) {
  const st = world.st;
  const sp = b.spec;
  const r = Math.hypot(b.p[0], b.p[2]);
  if (r + sp.rmax < st.R - 0.002) return;
  const openTop = bowlY(st.R, st) + st.pocketTop;
  const lintelR = st.R + st.flare.out;
  for (const L of sp.layers) {
    const rr = L.table.rmax;
    let best = null;
    for (const y of [L.y0, L.y1]) {
      const a = toWorld(b, 0, y, 0, [0, 0, 0]);
      const ar = Math.hypot(a[0], a[2]) || 1e-9;
      const below = a[1] < openTop;
      const w = nearestWall(st, a[0], a[2], rr, below);
      if (!w) continue;
      let c = { pen: rr - w.dist, wx: w.wx, wy: a[1], wz: w.wz, nx: w.nx, ny: 0, nz: w.nz };
      if (!below && pocketAt(Math.atan2(a[2], a[0]), st)) {
        // 口の上の縁より高い: はみ出した部分が上の縁の下面に当たる。内へ押し戻すのと下へ押し下げるのの浅い方
        const pr = rr - (lintelR - ar);
        const pv = a[1] - openTop;
        if (pv < pr && pv < c.pen) {
          c = { pen: pv, wx: (a[0] / ar) * Math.max(lintelR, ar), wy: openTop, wz: (a[2] / ar) * Math.max(lintelR, ar), nx: 0, ny: -1, nz: 0 };
        }
      }
      if (c.pen > -SLOP && (!best || c.pen > best.pen)) best = c;
    }
    if (best) {
      addContact(cs, b, null, best.wx, best.wy, best.wz, best.nx, best.ny, best.nz, best.pen,
        (L.mat.e + MATERIALS.wall.e) / 2, MATERIALS.wall.mu, { kind: 'wall', partA: L.part, soft: true });
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
  const r = L.table.rmax; // 包絡線
  for (let i = 0; i < 16; i++) {
    const phi = (i / 16) * TAU;
    const p = toWorld(b, Math.cos(phi) * r, L.y1, Math.sin(phi) * r, [0, 0, 0]);
    if (!best || p[1] > best[1]) best = p;
  }
  const pen = best[1] - st.ceiling;
  if (pen > -SLOP) addContact(cs, b, null, best[0], best[1], best[2], 0, -1, 0, pen, MATERIALS.wall.e, MATERIALS.wall.mu, { kind: 'ceiling', soft: true });
}

// レールは床から高さ h まで立ち上がる固い段差。ビットのギアは歯で噛み合い、軸先とビットの下部はただ当たる
function railContacts(world, b, cs, dt) {
  const st = world.st;
  const sp = b.spec;
  const g = toWorld(b, 0, (sp.gear.y0 + sp.gear.y1) / 2, 0, tmpA);
  if (Math.hypot(g[0], g[2]) < st.rail.r - st.rail.notchDepth - 0.02) return;
  // ギア: 歯車の噛み合い（ラックとピニオン）。歯が届いていれば押し付けの強さに関係なく力を伝え、
  // 上限は半クラッチのトルクだけ。歯は縦の溝なので、力はレールに沿った水平方向だけに働く
  railRing(world, b, cs, (sp.gear.y0 + sp.gear.y1) / 2, sp.gear.y0, GEAR_R, (c) => {
    c.kind = 'rail';
    c.mu = Infinity;
    c.tcap = (sp.gear.clutch * dt) / GEAR_R;
    c.tdir = [-c.nz, 0, c.nx];
  });
  // 軸先と、ビットの細い下部（ギアより下）
  const tipR = sp.tip.a + sp.tip.rr;
  railRing(world, b, cs, sp.tip.rr, 0, tipR, (c) => { c.kind = 'railside'; });
  railRing(world, b, cs, sp.gear.y0 * 0.6, sp.gear.y0 * 0.3, (tipR + BIT_R) / 2, (c) => { c.kind = 'railside'; });
}

// 軸上の高さ yc（下端 ylow）にある半径 rad の輪とレールの段差の接触
function railRing(world, b, cs, yc, ylow, rad, setup) {
  const st = world.st;
  const g = toWorld(b, 0, yc, 0, [0, 0, 0]);
  const r = Math.hypot(g[0], g[2]);
  const phi = Math.atan2(g[2], g[0]);
  // 輪の下端がレールの上端より低いときだけ当たる
  const lo = toWorld(b, 0, ylow, 0, tmpB);
  const lowY = lo[1] - rad * Math.hypot(b.R[1], b.R[7]);
  // ポケットの前ではレールが途切れている（壁沿いからそのまま入れる）。途切れた端には当たる
  const pk = pocketAt(phi, st);
  if (pk) {
    const e = wrap(phi - pk.center) > 0 ? pk.center + pk.half : pk.center - pk.half;
    const er = railRadius(e, st);
    const ex = Math.cos(e) * er;
    const ez = Math.sin(e) * er;
    const dx = g[0] - ex;
    const dz = g[2] - ez;
    const dist = Math.hypot(dx, dz) || 1e-9;
    const reachE = rad + st.rail.w * 0.6;
    if (dist > reachE || lowY > bowlY(er, st) + st.rail.h) return;
    const c = addContact(cs, b, null, ex, g[1], ez, dx / dist, 0, dz / dist, reachE - dist, 0.2, b.spec.tip.mu, {});
    c.kind = 'railside';
    return;
  }
  const rho = railRadius(phi, st);
  const d = r - rho;
  const face = st.rail.w * 0.6;
  const reach = rad + face;
  if (Math.abs(d) > reach) return;
  if (lowY > bowlY(rho, st) + st.rail.h) return;
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
  const c = addContact(cs, b, null, g[0] - nx * rad, g[1], g[2] - nz * rad, nx, 0, nz, pen, 0.2, b.spec.tip.mu, {});
  setup(c);
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
    const K = c.k || K_SOFT;
    const damp = 2 * zeta * Math.sqrt(K * mEff);
    relVel(c, vr);
    const vn = vr[0] * c.nx + vr[1] * c.ny + vr[2] * c.nz;
    c.vn0 = vn;
    // 数値的に深く入り込んだときに力が際限なく大きくならないよう、ばねの伸びは 6mm で頭打ち
    const Fn = Math.max(0, K * Math.min(c.pen, 0.006) - damp * vn);
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
        const lim = c.mu === Infinity ? c.tcap : Math.min(c.mu * c.jn, c.tcap);
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
    // 倒れた（ブレードやラチェットの下面の縁が床をこすり続けた）か、回転がほぼ止まった
    if (b.scrapeT > 0.3 || spin < 15) {
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
  // 平らな軸先は外周へ斜めに強く（レールに乗せる）、点の軸先は中央へそっと置く
  // （右回転は反時計回り、左回転は時計回りがレールを走る向き）
  if (spec.bit.a > 0.0012) launch(w, 0, { x: -0.1, z: 0.03, angle: Math.atan2(-0.03, 0.1) - spec.spinSign * 1.2, power: 0.95, bank: 1 });
  else launch(w, 0, { x: -0.1, z: 0, angle: 0, power: 0.2 });
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
