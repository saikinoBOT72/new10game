// パーツの形状（物理と描画で共通）。
// どのパーツも「軸まわりの極座標の輪郭 R(φ)」を縦に押し出した形として表す。
// 角度 φ はパーツ座標（y が回転軸、x-z が水平面）で atan2(z, x)。

export const NPOLAR = 512;

// ブレードの輪郭（刃の形）
export function bladeRadius(shape, R, phi, spinSign) {
  const n = shape.n;
  const inner = shape.inner;
  const ph = spinSign < 0 ? phi : -phi; // 左回転は刃の向きを反転
  switch (shape.kind) {
    case 'saw': {
      let f = ((ph * n) / (Math.PI * 2)) % 1;
      if (f < 0) f += 1;
      const edge = f > 0.82 ? (1 - f) / 0.18 : 1; // 刃先の面（約35°の斜面）
      return R * (inner + (1 - inner) * Math.pow(f, shape.p || 2) * edge);
    }
    case 'horn':
      return R * (inner + (1 - inner) * Math.pow(Math.abs(Math.cos(ph)), 4));
    case 'block': {
      const c = Math.cos(n * ph);
      const t = Math.max(0, Math.min(1, (c + 0.25) * 3));
      return R * (inner + (1 - inner) * t);
    }
    case 'ring':
      return R * (inner + (1 - inner) * (0.5 + 0.5 * Math.cos(n * ph)));
    default:
      return R * (inner + (1 - inner) * Math.pow(0.5 + 0.5 * Math.cos(n * ph), 0.5));
  }
}

// ラチェットの輪郭: 円筒に n 個の突起
export const RATCHET_BASE_R = 0.0112;
export const RATCHET_BUMP = 0.0019;
export function ratchetRadius(ratchet, phi) {
  const n = ratchet.n;
  const w = Math.min(0.34, (Math.PI / n) * 0.75); // 突起の半幅
  let bump = 0;
  for (let i = 0; i < n; i++) {
    let d = phi - (i / n) * Math.PI * 2;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < w) bump = Math.max(bump, Math.pow(Math.cos((d / w) * (Math.PI / 2)), 2));
  }
  return RATCHET_BASE_R + RATCHET_BUMP * bump;
}

export const BIT_R = 0.0075; // ビット本体（ギア）の半径
export const GEAR_R = 0.0072; // ギアの歯先の半径

// 極座標テーブル: 半径と外向き法線（パーツ座標の水平面内）
export function polarTable(fn) {
  const N = NPOLAR;
  const R = new Float64Array(N);
  for (let k = 0; k < N; k++) R[k] = fn((k / N) * Math.PI * 2);
  const nx = new Float64Array(N);
  const nz = new Float64Array(N);
  const dphi = (Math.PI * 2) / N;
  let rmax = 0;
  for (let k = 0; k < N; k++) {
    const phi = k * dphi;
    const dR = (R[(k + 1) % N] - R[(k - 1 + N) % N]) / (2 * dphi);
    // 接線 = R' r̂ + R φ̂ → 外向き法線 = R r̂ - R' φ̂
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const ax = R[k] * c + dR * s; // r̂=(c,s), φ̂=(-s,c)
    const az = R[k] * s - dR * c;
    const m = Math.hypot(ax, az) || 1;
    nx[k] = ax / m;
    nz[k] = az / m;
    rmax = Math.max(rmax, R[k]);
  }
  return { R, nx, nz, rmax };
}
