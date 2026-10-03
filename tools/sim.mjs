// ヘッドレスで大量に対戦させてバランスを見る: node tools/sim.mjs [試合数]
import { BLADES, RATCHETS, BITS, findPart } from '../src/parts.js';
import { buildSpec, createBattle, launch, step, judge } from '../src/physics.js';

const N = Number(process.argv[2] || 200);
const DT = 1 / 600;

const builds = {
  attack: ['saber', '4-50', 'F'],
  rubber: ['saber', '3-60', 'RF'],
  defense: ['fort', '9-60', 'N'],
  stamina: ['gale', '3-60', 'B'],
  balance: ['horn', '3-60', 'T'],
  lowatk: ['saber', '4-50', 'LF'],
  tallsta: ['gale', '5-70', 'B'],
  heavy: ['hammer', '4-50', 'LF'],
  left: ['fang', '3-60', 'T'],
};

function spec([b, r, t]) {
  return buildSpec(findPart(BLADES, b), findPart(RATCHETS, r), findPart(BITS, t));
}

function runMatch(sa, sb, seed) {
  const w = createBattle([sa, sb], { seed });
  const rng = w.rng;
  // 左右から打ち出す（ラウンドごとに立ち位置を入れ替える）
  const swap = seed % 2 === 1;
  const shoot = (i, x0) => launch(w, i, {
    x: swap ? -x0 : x0, z: (rng() - 0.5) * 0.04,
    angle: ((swap ? -x0 : x0) > 0 ? Math.PI : 0) + (rng() - 0.5) * 1.6,
    power: 0.75 + rng() * 0.25,
    bank: rng() < 0.3 ? 1 : 0,
  });
  shoot(0, -0.11);
  shoot(1, 0.11);
  let res = null;
  let rail = [0, 0];
  let hits = 0;
  let dashes = 0;
  while (w.t < 120 && !res) {
    step(w, DT);
    for (const b of w.beys) if (b.onRail) rail[b.idx] += DT;
    for (const e of w.events) {
      if (e.type === 'hit') hits++;
      if (e.type === 'dash') dashes++;
    }
    w.events.length = 0;
    res = judge(w);
  }
  return { res, t: w.t, rail, hits, dashes };
}

function solo(s, seed) {
  const w = createBattle([s], { seed });
  launch(w, 0, { x: 0, z: 0.1, angle: -Math.PI / 2, power: 0.9 });
  let maxV = 0;
  let rail = 0;
  let rsum = 0;
  let n = 0;
  while (w.t < 200 && w.beys[0].finish === null) {
    step(w, DT);
    const b = w.beys[0];
    maxV = Math.max(maxV, Math.hypot(b.vx, b.vz));
    if (b.onRail) rail += DT;
    rsum += Math.hypot(b.x, b.z);
    n++;
  }
  return { t: w.t, finish: w.beys[0].finish, maxV, rail, avgR: rsum / n };
}

console.log('--- ソロ（相手なし）');
for (const [name, b] of Object.entries(builds)) {
  const r = [1, 2, 3].map((s) => solo(spec(b), s));
  const avg = (k) => (r.reduce((a, x) => a + x[k], 0) / r.length).toFixed(2);
  console.log(name.padEnd(8), 't', avg('t'), 'maxV', avg('maxV'), 'rail', avg('rail'), 'avgR', avg('avgR'), r.map((x) => x.finish).join(','));
}

console.log(`--- 総当たり (${N}試合ずつ)`);
const names = Object.keys(builds);
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const sa = spec(builds[names[i]]);
    const sb = spec(builds[names[j]]);
    const tally = { a: 0, b: 0, d: 0 };
    const fin = {};
    let t = 0;
    let hits = 0;
    let dash = 0;
    for (let k = 0; k < N; k++) {
      const { res, t: tt, hits: h, dashes: dsh } = runMatch(sa, sb, 1000 + k);
      dash += dsh;
      t += tt;
      hits += h;
      if (!res) { tally.d++; continue; }
      if (res.winner === 0) tally.a++;
      else if (res.winner === 1) tally.b++;
      else tally.d++;
      const key = (res.winner === 0 ? 'A' : res.winner === 1 ? 'B' : '=') + res.type;
      fin[key] = (fin[key] || 0) + 1;
    }
    console.log(
      `${names[i].padEnd(8)} vs ${names[j].padEnd(8)}`,
      `${((tally.a / N) * 100).toFixed(0).padStart(3)}% - ${((tally.b / N) * 100).toFixed(0).padStart(3)}%  draw ${tally.d}`,
      `avg ${(t / N).toFixed(1)}s hits ${(hits / N).toFixed(0)} dash ${(dash / N).toFixed(1)}`,
      JSON.stringify(fin),
    );
  }
}
