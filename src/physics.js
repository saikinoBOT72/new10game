// コマバトルの物理演算（描画なし・決定的）。
//
// 座標: 上から見た x-z 平面、y が上。角速度 w は +y 軸まわり（w<0 が右回転＝上から見て時計回り）。
// 各コマは「位置・速度・回転数・軸の傾き(水平成分)」を持つ剛体として近似する。
//  - 床との接触点は軸から少しずれる（傾き＋スタジアムの斜面）。回転しながらその点が床を蹴るので、
//    フラット系のビットは勝手に走り出し、ボールやニードルは中央に留まる。
//  - 軸の傾きはジャイロ効果で歳差運動し、回転が落ちると不安定になって倒れる。
//  - コマ同士の衝突は接触点の表面速度（回転×半径）まで含めた撃力で解く。
//    同じ向きの回転同士は表面が逆向きにこすれるので激しく弾き合い、逆回転同士は回転を奪い合う。
//  - バーストは中層（ラチェット）に衝撃を受けたときだけ起こる。上層ブレード同士の当たりや
//    壁への衝突では外れない。ブレードが相手より高い（または傾いている）ほど、相手の刃が
//    自分の中層に届く。ロックはワンクリックで、外れやすさは
//    「ブレードの重さ（慣性）」「ラチェットの外周形状」「ビットのシャフトの太さ」で決まる。
//  - 外周のエクストリームラインではビットのギアが噛んで急加速し、射出ポイントで
//    スタジアムを縦断するように打ち出される。

export const G = 9.81;

export const STADIUM = {
  R: 0.19, // 壁の内半径
  curve: 0.6, // 床の高さ y = curve * r^2 + curve4 * r^4（外周ほど急になる）
  curve4: 12,
  wallH: 0.018,
  railBand: 0.006, // 壁からこの距離以内でギアがレールに噛む
  railMu: 0.7,
  railGearR: 0.0034,
  // 角度は atan2(z, x)。+z（カメラ側）にエクストリームゾーン、その左右にオーバーゾーン、
  // 対面（-z）がレールの切れ目＝射出ポイント。左右対称で、回転対称ではない。
  launch: { center: deg(-90), half: deg(13) },
  pockets: [
    // 入口が高い（lip が急）ので、強く弾かないと入らない
    { type: 'xtreme', center: deg(90), half: deg(15), lip: 1.5 },
    // フェンスから滑らかに続いているので、壁沿いに滑り込むこともある
    { type: 'over', center: deg(38), half: deg(9), lip: 0.3 },
    { type: 'over', center: deg(142), half: deg(9), lip: 0.3 },
  ],
  outMargin: 0.008, // 壁の位置をこれだけ越えたら場外
  wallE: 0.45,
  wallMu: 0.3,
};

const C_AIR = 2.0e-9; // 空気抵抗トルク係数 (N·m·s²)
const K_SMASH = 0.07; // 刃の凹凸が表面速度を押し出しに変える割合
const K_WSMASH = 0.012;
const L_UNLOCK = 5.0e-4; // 負荷 1 にあたる逆向き角力積 (N·m·s)
// ロック負荷: 中層への衝撃で溜まり、満タン（4段目の終わり）でバースト。
// 時間がたつと少しずつ戻るが、すでに越えた段の区切りより下には戻らない。
export const LOCK_STEPS = 4;
const LOCK_GAIN = 0.4; // 衝撃の負荷のうちゲージに溜まる割合
const LOCK_GRAZE = 0.15; // これ未満のかすり当たりは溜まらない
const LOCK_HEAL = 0.06; // 1秒あたりの自然回復
const BLADE_T = 0.006; // ブレードの厚み
const Q0 = 0.04; // フラット面が縁接地になる傾き
const TILT_HIT = 0.45;
const TILT_WALL = 0.25;
const FALL_TILT = 0.65; // 重力に対する傾き。これ以上傾いたら倒れる（スピンフィニッシュ）
const ALIGN = 0.7; // 起き上がりで軸が床の法線へ寄る割合
const W_MIN = 18; // これ以下の回転数で停止
export const SHAFT_RES = { thick: 1.35, thin: 0.8 };

function deg(d) {
  return (d * Math.PI) / 180;
}

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

export function floorY(r, st = STADIUM) {
  const rc = Math.min(r, st.R);
  let y = st.curve * rc * rc + st.curve4 * rc * rc * rc * rc;
  if (r > st.R) y -= (r - st.R) * 1.5; // ポケットの中へ落ちていく
  return y;
}

export function floorSlope(r, st = STADIUM) {
  const rc = Math.min(r, st.R);
  return 2 * st.curve * rc + 4 * st.curve4 * rc * rc * rc;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function pocketAt(angle, st = STADIUM) {
  for (const p of st.pockets) {
    if (Math.abs(wrapAngle(angle - p.center)) < p.half) return p;
  }
  return null;
}

// レールは射出ポイント以外の外周すべて
export function inRail(angle, st = STADIUM) {
  return Math.abs(wrapAngle(angle - st.launch.center)) > st.launch.half;
}

export function inLaunch(angle, st = STADIUM) {
  return !inRail(angle, st);
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// パーツの組み合わせから剛体パラメータを作る
export function buildSpec(blade, ratchet, bit) {
  const m = blade.m + ratchet.m + bit.m;
  const bladeH = bit.h + ratchet.h + 0.004; // ブレード中心の高さ（先端から）
  const I = blade.k * blade.m * blade.R * blade.R + 0.5 * ratchet.m * 0.012 * 0.012 + 0.5 * bit.m * 0.007 * 0.007;
  const hcm = (blade.m * bladeH + ratchet.m * (bit.h + ratchet.h * 0.5) + bit.m * bit.h * 0.5) / m;
  const Iperp = 0.5 * I + m * hcm * hcm;
  const wc = Math.sqrt(4 * m * G * hcm * Iperp) / I; // これより遅いと自立できない
  // ロックの外れにくさ: シャフトが太いほど強く、外周が丸いほど受け流し、ブレードが重いほど慣性で外れやすい
  const inertia = Math.pow(blade.m / 0.036, 2);
  const lock = (SHAFT_RES[bit.shaft] * (1 + ratchet.guard)) / inertia;
  return {
    blade, ratchet, bit,
    m, I, R: blade.R, H: bladeH, hcm, wc, lock,
    // 床に対してこれ以上傾くとブレードの縁が床をこする（高いほど粘れる）
    scrape: Math.atan((bladeH - BLADE_T / 2) / blade.R) + 0.08,
    spinSign: blade.spin === 'L' ? 1 : -1,
  };
}

// 相手の刃がどれだけ自分の中層（ラチェット）に届くか 0..1
export function ratchetExposure(me, opp, tilt = 0) {
  const higher = me.H - opp.H + 0.012 * tilt;
  return 0.08 + 0.92 * smoothstep(0.0005, 0.0045, higher);
}

// UI 表示用のざっくりした指標（0〜1）
export function specStats(spec) {
  const { blade, ratchet, bit } = spec;
  const drive = bit.a * bit.mu * 1000 + bit.rr * 200;
  const clamp = (v) => Math.max(0.04, Math.min(1, v));
  return {
    weight: spec.m * 1000,
    attack: clamp(blade.smash * 0.55 + drive * 0.28 + blade.mu * 0.2 - 0.05),
    defense: clamp((spec.m - 0.04) * 60 + (1 - blade.e) * 0.45 + (1 - drive) * 0.25),
    stamina: clamp(soloSpinTime(spec) / 75),
    burst: clamp((spec.lock - 0.5) / 1.7),
    dash: clamp(bit.gear * (0.5 + 0.5 * bit.clutch) * 0.7 + bit.a * 100),
    height: spec.H * 1000,
  };
}

// 持久力は実際に1個だけ回して測る（同じ組み合わせはキャッシュ）
const soloCache = new Map();
export function soloSpinTime(spec) {
  const key = `${spec.blade.id}|${spec.ratchet.id}|${spec.bit.id}`;
  if (soloCache.has(key)) return soloCache.get(key);
  const w = createBattle([spec], { seed: 7 });
  launch(w, 0, { x: 0, z: 0.1, angle: -Math.PI / 2, power: 0.9 });
  const dt = 1 / 300;
  while (w.t < 150 && w.beys[0].finish === null) step(w, dt);
  soloCache.set(key, w.t);
  return w.t;
}

export function createBattle(specs, { seed = 1, stadium = STADIUM } = {}) {
  return {
    st: stadium,
    t: 0,
    rng: makeRng(seed),
    events: [],
    beys: specs.map((spec, i) => newBey(spec, i)),
    pairCool: 0,
  };
}

function newBey(spec, idx) {
  return {
    idx, spec,
    x: 0, z: 0, vx: 0, vz: 0,
    w: 0, ax: 0, az: 0,
    relTilt: 0,
    lockLoad: 0, // ロック負荷 0..1（1でバースト）
    kickCool: 0,
    state: 'ready', // ready | spin | down | out | burst
    finish: null,
    onRail: false,
    wallCool: 0,
    phase: 0,
    y: 0, vy: 0, // 場外へ落ちるときだけ使う
    w0: 1,
  };
}

// power: 0..1, angle: 打ち出し方向(atan2(z,x)), bank: 傾けシュート
export function launch(world, idx, { x, z, angle, power, bank = 0 }) {
  const b = world.beys[idx];
  const rng = world.rng;
  const p = Math.max(0.05, Math.min(1, power));
  const quality = 0.94 + rng() * 0.08;
  b.x = x;
  b.z = z;
  const speed = (0.2 + 0.9 * p) * quality;
  b.vx = Math.cos(angle) * speed;
  b.vz = Math.sin(angle) * speed;
  b.w = b.spec.spinSign * (520 + 430 * p) * quality;
  b.w0 = Math.abs(b.w);
  // 傾けシュートは進行方向の横に軸を倒す
  const tilt = 0.01 + bank * 0.16;
  b.ax = Math.cos(angle + Math.PI / 2) * tilt;
  b.az = Math.sin(angle + Math.PI / 2) * tilt;
  b.state = 'spin';
  b.lockLoad = 0;
  b.finish = null;
  b.y = 0;
}

function emit(world, ev) {
  ev.t = world.t;
  world.events.push(ev);
}

export function step(world, dt) {
  world.t += dt;
  for (const b of world.beys) stepBey(world, b, dt);
  const [a, c] = world.beys;
  if (a && c) collidePair(world, a, c, dt);
  for (const b of world.beys) collideWall(world, b, dt);
}

function stepBey(world, b, dt) {
  const sp = b.spec;
  const st = world.st;
  const bit = sp.bit;
  b.onRail = false;
  b.wallCool -= dt;
  b.kickCool -= dt;
  // 自然回復は今いる段の区切りまで
  const lockFloor = Math.floor(b.lockLoad * LOCK_STEPS + 1e-9) / LOCK_STEPS;
  b.lockLoad = Math.max(lockFloor, b.lockLoad - LOCK_HEAL * dt);
  if (b.state === 'ready') return;

  if (b.state === 'out') {
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.vx *= 1 - 1.5 * dt;
    b.vz *= 1 - 1.5 * dt;
    b.vy -= G * dt;
    b.y = Math.max(b.y + b.vy * dt, -0.06);
    b.w *= 1 - 0.8 * dt;
    b.phase += b.w * dt;
    return;
  }
  if (b.state === 'burst') return;

  const r = Math.hypot(b.x, b.z) || 1e-9;
  const rx = b.x / r;
  const rz = b.z / r;
  const ang = Math.atan2(b.z, b.x);
  const pocket = pocketAt(ang, st);

  // 斜面: 法線の水平成分と重力の水平成分
  let s = floorSlope(r, st);
  if (pocket && r > st.R - sp.R) s += pocket.lip * Math.min(1, (r - (st.R - sp.R)) / sp.R);
  const inv = 1 / Math.sqrt(1 + s * s);
  const nhx = -s * inv * rx;
  const nhz = -s * inv * rz;
  let gx = -G * s * inv * inv * rx;
  let gz = -G * s * inv * inv * rz;
  const N = sp.m * G * inv;

  if (b.state === 'down') {
    // 倒れたコマは床をこすって止まる
    const v = Math.hypot(b.vx, b.vz);
    const dec = Math.min(v, 2.5 * dt);
    if (v > 1e-9) {
      b.vx -= (b.vx / v) * dec;
      b.vz -= (b.vz / v) * dec;
    }
    b.vx += gx * 0.3 * dt;
    b.vz += gz * 0.3 * dt;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.w *= Math.max(0, 1 - 6 * dt);
    b.phase += b.w * dt;
    return;
  }

  // 軸と床法線の相対的な傾き → 接触点のずれ d
  const qx = b.ax - nhx;
  const qz = b.az - nhz;
  const qm = Math.hypot(qx, qz);
  const dm = bit.rr * Math.sin(qm) + bit.a * Math.min(1, qm / Q0);
  const dx = qm > 1e-9 ? (qx / qm) * dm : 0;
  const dz = qm > 1e-9 ? (qz / qm) * dm : 0;

  // 接触点の速度 = 並進 + 回転 (ŷ×d = (dz, -dx))
  const cvx = b.vx + b.w * dz;
  const cvz = b.vz - b.w * dx;
  const cv = Math.hypot(cvx, cvz);
  let Fx = 0;
  let Fz = 0;
  let tau = 0;
  if (cv > 1e-9) {
    const mSlip = 1 / (1 / sp.m + (dm * dm) / sp.I);
    const F = Math.min(bit.mu * N, (mSlip * cv) / dt * 0.5);
    Fx = (-cvx / cv) * F;
    Fz = (-cvz / cv) * F;
    tau += dz * Fx - dx * Fz;
  }

  // エクストリームライン（壁際のギアレール）
  if (!pocket && bit.gear > 0 && inRail(ang, st) && r > st.R - sp.R - st.railBand) {
    const rg = st.railGearR;
    const tx = rz;
    const tz = -rx; // ŷ × r̂
    const target = -b.w * rg; // ギアが外側で噛んで転がる速度
    const vt = b.vx * tx + b.vz * tz;
    const mEff = 1 / (1 / sp.m + (rg * rg) / sp.I);
    // 半クラッチ: 硬いほどレールの力をそのまま受けて急加速するが、ぐらつきやすい
    const Fmax = bit.gear * st.railMu * N * (0.45 + 0.55 * bit.clutch);
    const Fg = Math.max(-Fmax, Math.min(Fmax, (mEff * (target - vt)) / dt * 0.5));
    Fx += Fg * tx;
    Fz += Fg * tz;
    tau += rg * Fg; // (rg r̂) × (Fg t̂)
    b.onRail = Math.abs(Fg) > 0.02;
    const wob = bit.clutch * Math.abs(Fg) * 2.2 * dt;
    b.ax += (world.rng() - 0.5) * wob;
    b.az += (world.rng() - 0.5) * wob;
  }

  // 射出ポイント: レールの切れ目で、壁沿いに走ってきたコマをスタジアムの反対側へ打ち出す
  if (b.kickCool <= 0 && inLaunch(ang, st) && r > st.R - sp.R - 0.008) {
    const tx = rz;
    const tz = -rx;
    const vt = b.vx * tx + b.vz * tz;
    const v = Math.hypot(b.vx, b.vz);
    if (Math.abs(vt) > 0.35) {
      // 中央の少し先（進んできた向きの側）を狙う
      const aimX = -rx * 0.13 + Math.sign(vt) * tx * 0.05;
      const aimZ = -rz * 0.13 + Math.sign(vt) * tz * 0.05;
      const ddx = aimX - b.x;
      const ddz = aimZ - b.z;
      const dd = Math.hypot(ddx, ddz);
      const sp2 = v * 0.92;
      b.vx = (ddx / dd) * sp2;
      b.vz = (ddz / dd) * sp2;
      b.kickCool = 0.6;
      emit(world, { type: 'dash', idx: b.idx, x: b.x, z: b.z, speed: sp2 });
    }
  }

  // 回転の減衰: 先端の回転摩擦＋空気抵抗
  const rpv = bit.pivot + (2 / 3) * bit.a * (1 - Math.min(1, qm / Q0));
  tau -= Math.sign(b.w) * bit.mu * N * rpv;
  tau -= C_AIR * sp.blade.drag * b.w * Math.abs(b.w);

  // 並進
  b.vx += (Fx / sp.m + gx) * dt;
  b.vz += (Fz / sp.m + gz) * dt;
  const damp = 1 - bit.roll * dt;
  b.vx *= damp;
  b.vz *= damp;
  b.x += b.vx * dt;
  b.z += b.vz * dt;

  // 回転（符号は反転させない）
  const nw = b.w + (tau / sp.I) * dt;
  b.w = Math.sign(nw) === Math.sign(b.w) ? nw : 0;
  b.phase += b.w * dt;

  // 軸の傾き: ジャイロの歳差運動 + 自立/転倒
  const aw = Math.abs(b.w);
  if (aw > 1e-6) {
    const om = Math.max(-80, Math.min(80, (sp.m * G * sp.hcm) / (sp.I * b.w)));
    const th = -om * dt;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const nax = b.ax * c - b.az * sn;
    b.az = b.ax * sn + b.az * c;
    b.ax = nax;
  }
  const ratio = aw / sp.wc;
  const rate = ratio > 1 ? -bit.rise * (1 - 1 / ratio) * 0.6 + 0.05 : 3.2 * (1 - ratio) + 0.6;
  // 摩擦による「起き上がり」は床の法線に向かって揃える（斜面では内側へ傾いたまま走る）
  const k = Math.exp(rate * dt);
  const tgx = nhx * ALIGN;
  const tgz = nhz * ALIGN;
  b.ax = tgx + (b.ax - tgx) * k;
  b.az = tgz + (b.az - tgz) * k;
  // 床の細かな凹凸による揺らぎ
  const jitter = 0.004 * Math.sqrt(dt) * (1 + 2 * Math.max(0, 1.5 - ratio));
  b.ax += (world.rng() - 0.5) * jitter;
  b.az += (world.rng() - 0.5) * jitter;

  const tilt = Math.hypot(b.ax, b.az);
  b.relTilt = Math.hypot(b.ax - nhx, b.az - nhz);
  if (tilt > FALL_TILT || b.relTilt > sp.scrape + 0.25 || aw < W_MIN) {
    b.state = 'down';
    b.finish = 'spin';
    emit(world, { type: 'down', idx: b.idx });
    return;
  }

  // ポケットの縁を越えたら場外
  if (pocket && r > st.R + st.outMargin) {
    b.state = 'out';
    b.finish = pocket.type;
    b.vy = 0.2;
    emit(world, { type: pocket.type, idx: b.idx, x: b.x, z: b.z });
  }
}

function tiltKick(b, hc, Jx, Jz, scale) {
  const sp = b.spec;
  if (Math.abs(b.w) < 1e-3) return;
  // 実際は衝撃の一部が床へ逃げるので、ジャイロへの角力積は割り引く
  let kx = (scale * hc * Jz) / (sp.I * b.w);
  let kz = (-scale * hc * Jx) / (sp.I * b.w);
  const km = Math.hypot(kx, kz);
  if (km > 0.4) {
    kx *= 0.4 / km;
    kz *= 0.4 / km;
  }
  b.ax += kx;
  b.az += kz;
}

// 中層への衝撃によるロックの負荷（1で外れる目安）
function lockStress(b, dL, exposure, striker) {
  if (b.state !== 'spin') return 0;
  if (Math.sign(dL) === Math.sign(b.w) || dL === 0) return 0; // 回転を後押しする向きでは外れない
  const spinFactor = 1 + 0.6 * (1 - Math.min(1, Math.abs(b.w) / 700)); // 回転が落ちるほど外れやすい
  return (Math.abs(dL) * exposure * striker * spinFactor) / (L_UNLOCK * b.spec.lock);
}

// 負荷をロックのゲージに溜める。満タンでバースト。戻り値: バーストしたか
function tryUnlock(world, b, stress, allowBurst = true) {
  if (b.state !== 'spin' || stress < LOCK_GRAZE) return false;
  const before = Math.floor(b.lockLoad * LOCK_STEPS + 1e-9);
  b.lockLoad = Math.min(allowBurst ? 1 : 0.999, b.lockLoad + stress * LOCK_GAIN);
  const after = Math.floor(b.lockLoad * LOCK_STEPS + 1e-9);
  if (b.lockLoad < 1) {
    emit(world, { type: after > before ? 'lockstep' : 'strain', idx: b.idx, stress, step: after });
    return false;
  }
  b.state = 'burst';
  b.finish = 'burst';
  emit(world, { type: 'burst', idx: b.idx, x: b.x, z: b.z, vx: b.vx, vz: b.vz, w: b.w });
  return true;
}

function collidePair(world, b1, b2, dt) {
  world.pairCool -= dt;
  const live = (b) => b.state === 'spin' || b.state === 'down';
  if (!live(b1) || !live(b2)) return;
  const s1 = b1.spec;
  const s2 = b2.spec;
  let nx = b2.x - b1.x;
  let nz = b2.z - b1.z;
  const dist = Math.hypot(nx, nz);
  const R1 = s1.R;
  const R2 = s2.R;
  if (dist >= R1 + R2 || dist < 1e-9) return;
  nx /= dist;
  nz /= dist;
  const tx = nz;
  const tz = -nx;

  // めり込みの解消（質量比）
  const pen = R1 + R2 - dist;
  const im1 = 1 / s1.m;
  const im2 = 1 / s2.m;
  const f1 = im1 / (im1 + im2);
  b1.x -= nx * pen * f1;
  b1.z -= nz * pen * f1;
  b2.x += nx * pen * (1 - f1);
  b2.z += nz * pen * (1 - f1);

  const w1 = b1.state === 'spin' ? b1.w : 0;
  const w2 = b2.state === 'spin' ? b2.w : 0;
  const rvx = b2.vx - w2 * R2 * tx - (b1.vx + w1 * R1 * tx);
  const rvz = b2.vz - w2 * R2 * tz - (b1.vz + w1 * R1 * tz);
  const vn = rvx * nx + rvz * nz;
  const vt = rvx * tx + rvz * tz;

  // どの高さで当たったか: 高い側は相手の刃に中層を叩かれる
  const ex1 = ratchetExposure(s1, s2, b1.relTilt || 0);
  const ex2 = ratchetExposure(s2, s1, b2.relTilt || 0);
  // 接触面の弾く力: ブレード同士なら刃の形、中層に当たればラチェットの外周形状が効く
  const surf1 = s1.blade.smash * (1 - ex2) + s1.ratchet.edge * ex2 * 0.5 + s1.blade.smash * ex2 * 0.5;
  const surf2 = s2.blade.smash * (1 - ex1) + s2.ratchet.edge * ex1 * 0.5 + s2.blade.smash * ex1 * 0.5;

  const mN = 1 / (im1 + im2);
  let Jn = 0;
  const e = (s1.blade.e + s2.blade.e) / 2;
  if (vn < 0) Jn = -(1 + e) * vn * mN;
  let Jsm = 0;
  if (world.pairCool <= 0 && (vn < 0.05)) {
    const smash = (surf1 + surf2) / 2;
    Jsm = K_SMASH * smash * mN * Math.min(Math.abs(vt), 40) * (0.55 + world.rng() * 0.9);
    world.pairCool = 0.045;
  }
  const JnT = Jn + Jsm;
  if (JnT <= 0) return;

  const mT = 1 / (im1 + im2 + (R1 * R1) / s1.I + (R2 * R2) / s2.I);
  const mu = (s1.blade.mu + s2.blade.mu) / 2;
  const Jt = Math.max(-mu * JnT, Math.min(mu * JnT, -vt * mT));

  const Jx = JnT * nx + Jt * tx;
  const Jz = JnT * nz + Jt * tz;
  b2.vx += Jx * im2;
  b2.vz += Jz * im2;
  b1.vx -= Jx * im1;
  b1.vz -= Jz * im1;
  const dL2 = -R2 * Jt;
  const dL1 = -R1 * Jt;
  if (b2.state === 'spin') b2.w += dL2 / s2.I;
  if (b1.state === 'spin') b1.w += dL1 / s1.I;

  // 当たった高さでジャイロが傾く。高い方は下からかち上げられる
  const hc = (s1.H + s2.H) / 2;
  if (b2.state === 'spin') tiltKick(b2, hc, Jx, Jz, TILT_HIT);
  if (b1.state === 'spin') tiltKick(b1, hc, -Jx, -Jz, TILT_HIT);
  const dh = s1.H - s2.H;
  if (Math.abs(dh) > 0.0005) {
    const up = Math.min(Math.abs(dh) / 0.003, 1.5) * 0.12 * JnT;
    if (dh > 0 && b1.state === 'spin') {
      b1.ax -= (nx * up) / s1.m;
      b1.az -= (nz * up) / s1.m;
    } else if (dh < 0 && b2.state === 'spin') {
      b2.ax += (nx * up) / s2.m;
      b2.az += (nz * up) / s2.m;
    }
  }

  // 中層に届いた刃が鋭いほどロックが回される
  const st1 = lockStress(b1, dL1, ex1, 0.4 + 0.8 * s2.blade.smash);
  const st2 = lockStress(b2, dL2, ex2, 0.4 + 0.8 * s1.blade.smash);
  // 同時バーストは起こさない（負荷の大きい方から判定）
  if (st1 >= st2) {
    tryUnlock(world, b2, st2, !tryUnlock(world, b1, st1));
  } else {
    tryUnlock(world, b1, st1, !tryUnlock(world, b2, st2));
  }

  const strength = JnT + Math.abs(Jt);
  if (strength > 0.004) {
    emit(world, {
      type: 'hit',
      x: b1.x + nx * R1, z: b1.z + nz * R1,
      nx, nz, strength,
      same: Math.sign(w1) === Math.sign(w2),
      low: Math.max(ex1, ex2) > 0.4, // 中層への当たり
    });
  }
}

function collideWall(world, b, dt) {
  if (b.state !== 'spin' && b.state !== 'down') return;
  const st = world.st;
  const sp = b.spec;
  const r = Math.hypot(b.x, b.z);
  if (r + sp.R <= st.R) return;
  const ang = Math.atan2(b.z, b.x);
  if (pocketAt(ang, st)) return; // ポケットには壁がない
  const nx = b.x / r;
  const nz = b.z / r;
  const tx = nz;
  const tz = -nx;
  b.x = nx * (st.R - sp.R);
  b.z = nz * (st.R - sp.R);

  const w = b.state === 'spin' ? b.w : 0;
  const vn = b.vx * nx + b.vz * nz;
  if (b.onRail) {
    // レールに噛んでいる間は、遠心力をギアが受け止める（壁にはこすらない）
    if (vn > 0) {
      b.vx -= nx * vn;
      b.vz -= nz * vn;
    }
    return;
  }
  const vt = b.vx * tx + b.vz * tz + w * sp.R;
  let Jn = 0;
  if (vn > 0) Jn = (1 + st.wallE * (0.5 + sp.blade.e)) * vn * sp.m;
  let Jsm = 0;
  if (b.wallCool <= 0 && b.state === 'spin') {
    Jsm = K_WSMASH * sp.blade.smash * sp.m * Math.min(Math.abs(vt), 25) * (0.5 + world.rng());
    b.wallCool = 0.06;
  }
  const JnT = Jn + Jsm;
  if (JnT <= 0) return;
  const mT = 1 / (1 / sp.m + (sp.R * sp.R) / sp.I);
  const Jt = Math.max(-st.wallMu * JnT, Math.min(st.wallMu * JnT, -vt * mT));
  const Jx = -nx * JnT + tx * Jt;
  const Jz = -nz * JnT + tz * Jt;
  b.vx += Jx / sp.m;
  b.vz += Jz / sp.m;
  if (b.state === 'spin') {
    const dL = sp.R * Jt;
    b.w += dL / sp.I;
    tiltKick(b, sp.H, Jx, Jz, TILT_WALL); // 壁に当たるのは上層だけなのでバーストはしない
  }
  if (Jn > 0.006) emit(world, { type: 'wall', idx: b.idx, x: b.x + nx * sp.R, z: b.z + nz * sp.R, strength: JnT });
}

// ラウンドの決着判定。null なら続行
export const POINTS = { spin: 1, over: 2, burst: 2, xtreme: 3 };

export function judge(world) {
  const [a, b] = world.beys;
  const doneA = a.finish !== null;
  const doneB = b.finish !== null;
  if (!doneA && !doneB) return null;
  if (doneA && doneB) {
    // 同時に終わった場合はより重い決着を優先、同じなら引き分け
    const pa = POINTS[a.finish];
    const pb = POINTS[b.finish];
    if (pa === pb) return { winner: -1, type: a.finish, points: 0 };
    return pa > pb ? { winner: 1, type: a.finish, points: pa } : { winner: 0, type: b.finish, points: pb };
  }
  const loser = doneA ? a : b;
  return { winner: doneA ? 1 : 0, type: loser.finish, points: POINTS[loser.finish] };
}
