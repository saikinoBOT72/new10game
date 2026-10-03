// ヘッドレスで対戦させて決着の内訳を見る: node tools/sim.mjs [1組あたりの試合数]
import { BLADES, RATCHETS, BITS, findPart } from '../src/parts.js';
import { buildSpec, createBattle, launch, advance, judge } from '../src/physics.js';

const N = Number(process.argv[2] || 6);
const only = process.argv[3]; // 例: attack,stamina

const builds = {
  attack: ['saber', '3-60', 'F'],
  lowatk: ['saber', '4-50', 'LF'],
  rubber: ['saber', '3-60', 'RF'],
  heavy: ['hammer', '4-50', 'F'],
  balance: ['horn', '3-60', 'T'],
  defense: ['fort', '9-60', 'N'],
  stamina: ['gale', '3-60', 'B'],
  tallsta: ['gale', '5-70', 'B'],
  left: ['fang', '3-60', 'T'],
};

const spec = ([b, r, t]) => buildSpec(findPart(BLADES, b), findPart(RATCHETS, r), findPart(BITS, t));

function runMatch(sa, sb, seed) {
  const w = createBattle([sa, sb], { seed });
  const rng = w.rng;
  const swap = seed % 2 === 1;
  const side = (i) => ((i === 0) !== swap ? -1 : 1);
  for (const i of [0, 1]) {
    const x = side(i) * (0.08 + rng() * 0.05);
    const z = (rng() - 0.5) * 0.08;
    launch(w, i, { x, z, angle: Math.atan2(-z, -x) + (rng() - 0.5) * 1.4, power: 0.75 + rng() * 0.25, bank: rng() < 0.3 ? 1 : 0 });
  }
  let res = null;
  let hits = 0;
  let dashes = 0;
  while (w.t < 240 && !res) {
    advance(w, 0.02);
    for (const e of w.events) {
      if (e.type === 'hit') hits++;
    }
    for (const b of w.beys) if (b.onRail) dashes++;
    w.events.length = 0;
    res = judge(w);
  }
  return { res, t: w.t, hits };
}

const names = Object.keys(builds).filter((n) => !only || only.split(',').includes(n));
const t0 = Date.now();
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const sa = spec(builds[names[i]]);
    const sb = spec(builds[names[j]]);
    const tally = { a: 0, b: 0, d: 0 };
    const fin = {};
    let t = 0;
    let hits = 0;
    for (let k = 0; k < N; k++) {
      const { res, t: tt, hits: h } = runMatch(sa, sb, 1000 + k);
      t += tt;
      hits += h;
      if (!res || res.winner < 0) { tally.d++; continue; }
      if (res.winner === 0) tally.a++;
      else tally.b++;
      const key = (res.winner === 0 ? 'A' : 'B') + res.type;
      fin[key] = (fin[key] || 0) + 1;
    }
    console.log(
      `${names[i].padEnd(8)} vs ${names[j].padEnd(8)}`,
      `${tally.a}-${tally.b} draw ${tally.d}`,
      `avg ${(t / N).toFixed(1)}s hits ${(hits / N).toFixed(0)}`,
      JSON.stringify(fin),
    );
  }
}
console.log(`cpu ${((Date.now() - t0) / 1000).toFixed(0)}s`);
