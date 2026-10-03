import { BLADES, RATCHETS, BITS, LAYERS, SHAFT, findPart } from './parts.js';
import { buildSpec, soloRunner, createBattle, launch, advance, judge, POINTS } from './physics.js';
import { Renderer, TEAM_COLORS } from './render.js';
import { Sound } from './audio.js';

// 物理の時間を現実の何倍で進めるか（標準は 0.5 倍のスロー）
const TIME_SCALE = 0.5;
// 1フレームで計算する物理時間の上限（重い端末で固まらないように）
const MAX_SIM_PER_FRAME = 1 / 30;
const TARGET = 4;
// 左右から向かい合って打つ。スタジアムは左右対称だが回転対称ではないので、ラウンドごとに入れ替える。
// 自分の側の扇形の中なら、タップで好きな位置から打てる
const ZONE = { r0: 0.04, r1: 0.15, margin: 0.2 };
const sideSign = (i) => ((i === 0) !== state.swap ? -1 : 1); // -1: 左, +1: 右
const startPos = (i) => state.pos[i];

// 自分の側の扇形（中心角）
function sideSector(i) {
  const c = sideSign(i) < 0 ? Math.PI : 0;
  const half = Math.PI / 2 - ZONE.margin;
  return { c, half };
}

function clampToSide(i, x, z) {
  const { c, half } = sideSector(i);
  let a = Math.atan2(z, x) - c;
  a = Math.atan2(Math.sin(a), Math.cos(a));
  a = Math.max(-half, Math.min(half, a)) + c;
  const r = Math.max(ZONE.r0, Math.min(ZONE.r1, Math.hypot(x, z)));
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

function randomPos(i) {
  const { c, half } = sideSector(i);
  const a = c + (Math.random() * 2 - 1) * half * 0.8;
  const r = 0.07 + Math.random() * 0.07;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
const CATS = { blade: BLADES, ratchet: RATCHETS, bit: BITS };
const FINISH_NAME = { spin: 'SPIN FINISH', over: 'OVER FINISH', burst: 'BURST FINISH', xtreme: 'XTREME FINISH' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const canvas = $('#view');
const R = new Renderer(canvas);
const sound = new Sound();

const saved = load();
const state = {
  screen: 'custom', // custom | aim | battle
  mode: 'com',
  diff: saved?.diff ?? 1,
  sel: saved?.sel ?? [
    { blade: 'saber', ratchet: '3-60', bit: 'F' },
    { blade: 'gale', ratchet: '3-60', bit: 'B' },
  ],
  score: [0, 0],
  world: null,
  specs: [null, null],
  aims: [null, null],
  aimIdx: -1,
  drag: null,
  bank: false,
  result: null,
  resultT: 0,
  bannerShown: false,
  speed: 1,
  acc: 0,
  autoT: 0,
  swap: false,
  pos: [{ x: -0.11, z: 0 }, { x: 0.11, z: 0 }],
};

function load() {
  try {
    return JSON.parse(localStorage.getItem('spingear') || 'null');
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem('spingear', JSON.stringify({ sel: state.sel, diff: state.diff }));
  } catch {
    /* 保存できなくても遊べる */
  }
}

function specOf(i) {
  const s = state.sel[i];
  return buildSpec(findPart(BLADES, s.blade), findPart(RATCHETS, s.ratchet), findPart(BITS, s.bit));
}

// ---------- カスタマイズ画面 ----------

function buildCustom() {
  $$('.part-row').forEach((row) => {
    const L = LAYERS[$('.chips', row).dataset.cat];
    $('.part-label', row).innerHTML = `<b>${L.name}</b><em>${L.layer}</em>${L.role}`;
  });
  $$('.card').forEach((card) => {
    const side = Number(card.dataset.side);
    $$('.chips', card).forEach((box) => {
      const cat = box.dataset.cat;
      box.innerHTML = '';
      for (const p of CATS[cat]) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.dataset.id = p.id;
        const sub = cat === 'blade' ? `${p.type}・${(p.m * 1000).toFixed(1)}g`
          : cat === 'ratchet' ? `高さ${(p.h * 1000).toFixed(1)}mm・突起${p.n}`
            : `${p.type}・シャフト${SHAFT[p.shaft].name}`;
        b.innerHTML = `${p.name}<small>${sub}</small>`;
        b.onclick = () => {
          state.sel[side][cat] = p.id;
          save();
          refreshCustom();
        };
        box.appendChild(b);
      }
    });
    $('[data-random]', card).onclick = () => {
      const pick = (l) => l[Math.floor(Math.random() * l.length)].id;
      state.sel[side] = { blade: pick(BLADES), ratchet: pick(RATCHETS), bit: pick(BITS) };
      save();
      refreshCustom();
    };
  });
  $$('#diff button').forEach((b) => {
    b.onclick = () => {
      state.diff = Number(b.dataset.diff);
      save();
      refreshCustom();
    };
  });
  $$('.modes .mode').forEach((b) => {
    b.onclick = () => {
      sound.unlock();
      startMatch(b.dataset.mode);
    };
  });
  refreshCustom();
}

function refreshCustom() {
  $$('.card').forEach((card) => {
    const side = Number(card.dataset.side);
    const sel = state.sel[side];
    $$('.chips', card).forEach((box) => {
      $$('.chip', box).forEach((c) => c.classList.toggle('on', c.dataset.id === sel[box.dataset.cat]));
    });
    const spec = specOf(side);
    $('[data-combo]', card).innerHTML = `${spec.blade.name} ${spec.ratchet.name}${spec.bit.id}<small>${(spec.m * 1000).toFixed(1)}g ・ ${spec.blade.spin === 'L' ? '左回転' : '右回転'}</small>`;
    $('[data-stats]', card).innerHTML = physRows(spec).map(([k, v, f]) => `<span>${k}</span><div class="pv"><div class="meter"><i style="width:${(Math.max(0.04, Math.min(1, f)) * 100).toFixed(0)}%"></i></div><b>${v}</b></div>`).join('')
      + `<span>単体で回る時間</span><div class="pv"><div class="meter"><i data-solo style="width:0%"></i></div><b data-solo-t>計算中…</b></div>`;
    startSolo(side, spec);
    $('[data-desc]', card).innerHTML = comboNotes(spec).map((t) => `<span class="note">${t}</span>`).join('')
      + `<span class="parts-desc">上層: ${spec.blade.desc}<br>中層: ${spec.ratchet.desc}<br>下層: ${spec.bit.desc}</span>`;
    state.specs[side] = spec;
    R.setBey(side, spec);
  });
  $$('#diff button').forEach((b) => b.classList.toggle('on', Number(b.dataset.diff) === state.diff));
  $('#matchup').innerHTML = matchupNotes(state.specs[0], state.specs[1]);
}

// 物理量そのものを見せる（バーの長さは全パーツの範囲に対する位置）
function physRows(spec) {
  const I = spec.I[4] * 1e6;
  const w0 = 0.95 * (520 + 430 * 0.9); // 標準的なシュートの回転数
  const E = 0.5 * spec.I[4] * w0 * w0;
  const lock = spec.lockFull * 1e3;
  return [
    ['重さ', `${(spec.m * 1000).toFixed(1)} g`, (spec.m - 0.042) / 0.008],
    ['回転の慣性モーメント', `${I.toFixed(2)}×10⁻⁶ kg·m²`, (I - 7.5) / 5],
    ['回転エネルギー', `${E.toFixed(2)} J`, (E - 2.5) / 2.5],
    ['空気抵抗', `${(spec.air * 1e10).toFixed(1)}×10⁻¹⁰`, (spec.air * 1e10 - 3) / 6],
    ['軸先の平面の半径', `${(spec.bit.a * 1000).toFixed(1)} mm`, spec.bit.a / 0.002],
    ['軸先の摩擦係数', spec.tip.mu.toFixed(2), (spec.tip.mu - 0.2) / 0.45],
    ['クラッチのトルク', `${(spec.bit.clutch * 1000).toFixed(1)} mN·m`, spec.bit.clutch / 0.008],
    ['ロックの強さ', `${lock.toFixed(2)} mN·m·s`, (lock - 0.6) / 0.8],
    ['ブレードの高さ', `${(spec.bladeBand[0] * 1000).toFixed(1)}〜${(spec.bladeBand[1] * 1000).toFixed(1)} mm`, (spec.H - 0.018) / 0.006],
  ];
}

// 単体で回したときの時間は、画面を止めないよう少しずつ計算する
const solo = [null, null];
function startSolo(side, spec) {
  solo[side] = soloRunner(spec);
  showSolo(side);
}
function showSolo(side) {
  const r = solo[side];
  const card = $(`.card[data-side="${side}"]`);
  if (!r || !card) return;
  const bar = $('[data-solo]', card);
  const txt = $('[data-solo-t]', card);
  if (!bar || !txt) return;
  if (r.done) {
    txt.textContent = `${r.time.toFixed(0)} 秒`;
    bar.style.width = `${Math.min(100, (r.time / 160) * 100).toFixed(0)}%`;
  } else txt.textContent = '計算中…';
}
function runSolo() {
  for (const side of [0, 1]) {
    const r = solo[side];
    if (r && !r.done) {
      if (r.run(6)) showSolo(side);
      return; // 1フレームに1つずつ
    }
  }
}

// 組み合わせ診断: 物理的に起きることを言葉にする
function comboNotes(spec) {
  const { blade, ratchet, bit } = spec;
  const notes = [];
  const sharp = blade.shape.kind === 'saw' || blade.shape.kind === 'block' || blade.shape.kind === 'horn';
  const stamTip = bit.a === 0;
  if (spec.H <= 0.0186) notes.push('○ 背が低い: 重心が低く、ブレードが相手のラチェットの高さに届きやすい');
  if (spec.H >= 0.0208) notes.push('△ 背が高い: 低い相手の刃が自分のラチェットに当たりやすい');
  if (blade.m >= 0.038) notes.push('△ ブレードが重い: ラチェットを叩かれると、ブレードの慣性の分だけロックに大きな力がかかる');
  if (bit.shaft === 'thin') notes.push('△ シャフトが細い: ロックの締め付けが弱い');
  if (bit.clutch >= 0.006) notes.push('◎ クラッチが強い: レールの上で回転を速度に変えやすい（そのぶん回転は減る）');
  if (sharp && stamTip) notes.push('○ 角のある刃×点の軸先: 中央で待って、来た相手を弾く');
  if (!sharp && bit.a > 0) notes.push('△ 丸い刃で走り回る: 当たっても弾く力が小さく、回転を減らすだけになりやすい');
  if (ratchet.n === 1) notes.push('△ 一枚突起: 重心が軸から少しずれていて、わずかに振れながら回る');
  if (blade.spin === 'L') notes.push('○ 左回転: 右回転の相手とは接点の表面が同じ向きに動き、こすれずに回転を奪い合う');
  if (!notes.length) notes.push('○ 素直な組み合わせ。相手の高さを見てラチェットを選ぼう');
  return notes.slice(0, 4);
}

// 高さの相性: 自分のブレードの帯が相手のラチェットの帯にどれだけ重なるか
function matchupNotes(a, b) {
  if (!a || !b) return '';
  const names = setNames();
  const reach = (x, y) => (Math.min(x.bladeBand[1], y.ratchetBand[1]) - Math.max(x.bladeBand[0], y.ratchetBand[0])) * 1000;
  const ra = reach(a, b);
  const rb = reach(b, a);
  const line = (n, o, r) => (r > 0
    ? `${n}のブレードは${o}のラチェットに ${r.toFixed(1)}mm 重なる（当たると${o}のロックに力がかかる）`
    : `${n}のブレードは${o}のラチェットに届かない（あと ${(-r).toFixed(1)}mm）`);
  return `<b>高さの相性（まっすぐ立っているとき）</b>${line(names[0], names[1], ra)}<br>${line(names[1], names[0], rb)}<small>傾いたり跳ねたりすると、届く高さは変わります</small>`;
}

function setNames() {
  const names = state.mode === 'pvp' ? ['P1', 'P2'] : state.mode === 'watch' ? ['COM 1', 'COM 2'] : ['あなた', 'COM'];
  names.forEach((n, i) => ($(`[data-hud-name="${i}"]`).textContent = n));
  $$('.card [data-name]').forEach((el, i) => (el.textContent = names[i]));
  return names;
}

// ---------- 試合の進行 ----------

function startMatch(mode) {
  state.mode = mode;
  state.score = [0, 0];
  document.body.classList.remove('custom');
  $('#hud').hidden = false;
  setNames();
  R.setCamera('battle');
  startRound();
}

function backToCustom() {
  state.screen = 'custom';
  state.world = null;
  document.body.classList.add('custom');
  $('#hud').hidden = true;
  $('#banner').hidden = true;
  R.hideArrow();
  R.clearDebris();
  R.setCamera('preview');
  setNames();
  refreshCustom();
  sound.update(null);
}

function humans() {
  if (state.mode === 'watch') return [false, false];
  if (state.mode === 'pvp') return [true, true];
  return [true, false];
}

function startRound() {
  R.clearDebris();
  state.specs = [specOf(0), specOf(1)];
  state.world = createBattle(state.specs, { seed: (Math.random() * 1e9) | 0 });
  const h = humans();
  state.pos = [0, 1].map((i) => (h[i] ? { x: sideSign(i) * 0.11, z: 0 } : randomPos(i)));
  state.specs.forEach((s, i) => {
    R.setBey(i, s);
    const p = startPos(i);
    R.placeReady(i, p.x, p.z);
  });
  state.result = null;
  state.bannerShown = false;
  state.acc = 0;
  state.aims = [null, null];
  h.forEach((isHuman, i) => {
    if (!isHuman) state.aims[i] = comAim(i);
  });
  state.screen = 'aim';
  state.autoT = 0;
  R.controls.enabled = !humans().some(Boolean); // 照準のドラッグでカメラが回らないように
  $('#banner').hidden = true;
  nextAimer();
  renderScore();
}

function nextAimer() {
  const h = humans();
  state.aimIdx = h.findIndex((isHuman, i) => isHuman && !state.aims[i]);
  const hint = $('#aimHint');
  if (state.aimIdx < 0) {
    hint.hidden = true;
    R.hideArrow();
    R.hideZone();
    if (h.some(Boolean)) launchAll();
    return;
  }
  hint.hidden = false;
  const who = state.mode === 'pvp' ? `P${state.aimIdx + 1}: ` : '';
  const side = sideSign(state.aimIdx) < 0 ? '左' : '右';
  $('[data-aim-text]').textContent = `${who}${side}側をタップで位置を決めて、引っ張って離すとシュート！`;
  const { c, half } = sideSector(state.aimIdx);
  R.showZone(c - half, c + half, ZONE.r0, ZONE.r1, TEAM_COLORS[state.aimIdx]);
  showDefaultAim();
}

// まだ引っ張っていないときは、中央へ向けた薄い矢印を出しておく
function showDefaultAim() {
  const s = startPos(state.aimIdx);
  R.hideBand();
  R.showArrow(s.x, s.z, Math.atan2(-s.z, -s.x), 0.35, TEAM_COLORS[state.aimIdx], 0.3);
}

function comAim(i) {
  const spec = state.specs[i];
  const s = startPos(i);
  const toCenter = Math.atan2(-s.z, -s.x);
  const diff = state.mode === 'watch' ? 2 : state.diff;
  const r = Math.random;
  const attacker = spec.bit.a > 0.0012;
  let angle = toCenter + (r() - 0.5) * [1.6, 1.1, 0.6][diff];
  // 攻撃型は斜めに打ち出してレールに乗せる
  if (attacker && r() < 0.55) angle = toCenter + (r() < 0.5 ? 1 : -1) * (0.8 + r() * 0.5);
  const power = [0.5, 0.7, 0.88][diff] + r() * [0.3, 0.22, 0.12][diff];
  return { angle, power, bank: attacker && r() < 0.5 ? 1 : 0 };
}

function launchAll() {
  const w = state.world;
  state.aims.forEach((a, i) => launch(w, i, { x: startPos(i).x, z: startPos(i).z, angle: a.angle, power: a.power, bank: a.bank }));
  state.screen = 'battle';
  R.controls.enabled = true;
  $('#aimHint').hidden = true;
  R.hideArrow();
  R.hideBand();
  R.hideZone();
  sound.event({ type: 'launch' });
  flash('GO SHOOT!');
}

function flash(text) {
  const f = $('#flash');
  f.textContent = text;
  f.hidden = false;
  f.style.animation = 'none';
  void f.offsetWidth;
  f.style.animation = '';
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (f.hidden = true), 900);
}

function onResult(res) {
  state.result = res;
  state.resultT = 0;
  if (res.winner >= 0) state.score[res.winner] += res.points;
  renderScore();
}

function showBanner() {
  state.bannerShown = true;
  const res = state.result;
  const names = setNames();
  const f = $('[data-finish]');
  f.className = `finish ${res.type}`;
  f.textContent = res.winner < 0 ? 'DRAW' : FINISH_NAME[res.type];
  const over = state.score.some((s) => s >= TARGET);
  let gain = res.winner < 0 ? '同時に決着。ポイントなし' : `${names[res.winner]} +${res.points}`;
  if (over) {
    const w = state.score[0] >= TARGET ? 0 : 1;
    gain = `${gain}<br><span style="font-size:22px">${names[w]}の勝ち！ (${state.score[0]} - ${state.score[1]})</span>`;
    sound.event({ type: 'finish' });
  }
  $('[data-gain]').innerHTML = gain;
  $('#btnNext').textContent = over ? 'もう一度' : '次のラウンド';
  $('#btnBack').hidden = !over;
  $('#banner').hidden = false;
}

function renderScore() {
  [0, 1].forEach((i) => {
    const el = $(`[data-pts="${i}"]`);
    el.innerHTML = Array.from({ length: TARGET }, (_, k) => `<i class="${k < state.score[i] ? 'on' : ''}"></i>`).join('');
  });
}

function updateHud() {
  const w = state.world;
  if (!w) return;
  w.beys.forEach((b, i) => {
    const rpm = b.state === 'spin' ? (Math.abs(b.spin) * 60) / (2 * Math.PI) : 0;
    $(`[data-rpm="${i}"]`).textContent = Math.round(rpm).toLocaleString();
    $(`[data-bar="${i}"]`).style.width = `${Math.min(100, (rpm / 9000) * 100)}%`;
    // ロック負荷: 4段。越えた段（赤）は自然回復では戻らない
    const load = b.state === 'burst' ? 1 : b.lockLoad;
    $$(`[data-lock="${i}"] i`).forEach((cell, k) => {
      const f = Math.max(0, Math.min(1, load * 4 - k));
      cell.firstChild.style.width = `${(f * 100).toFixed(0)}%`;
      cell.classList.toggle('full', f >= 1);
    });
    const v = b.speed;
    const tilt = (b.tilt * 180) / Math.PI;
    const label = { spin: b.onRail ? 'レール' : '', down: '停止', out: '場外', burst: 'バースト', ready: '' }[b.state];
    $(`[data-phys="${i}"]`).textContent = `${v.toFixed(2)} m/s ・ 傾き ${tilt.toFixed(0)}° ${label}`;
  });
}

// ---------- 入力（照準） ----------

// タップ: 自分の側の中でスタート位置を動かす
// ドラッグ: モンスト式に引っ張る。引いた向きの反対へ、引いた長さに応じた強さで飛ぶ
const TAP_PX = 10;

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (state.screen !== 'aim' || state.aimIdx < 0) return;
  const p = R.pickFloor(e.clientX, e.clientY);
  if (!p) return;
  state.drag = { sx: e.clientX, sy: e.clientY, p0: p, pulling: false, angle: null, power: 0 };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const d = state.drag;
  if (!d || state.screen !== 'aim') return;
  const px = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
  if (!d.pulling && px < TAP_PX) return;
  d.pulling = true;
  const p = R.pickFloor(e.clientX, e.clientY);
  if (!p) return;
  const dx = p.x - d.p0.x;
  const dz = p.z - d.p0.z;
  const full = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.38;
  d.power = Math.min(1, Math.max(0, px - TAP_PX) / full);
  if (Math.hypot(dx, dz) > 0.002) d.angle = Math.atan2(-dz, -dx); // 引いた向きの反対
  const s = startPos(state.aimIdx);
  if (d.angle !== null) {
    const col = TEAM_COLORS[state.aimIdx];
    R.showArrow(s.x, s.z, d.angle, d.power, col, d.power < 0.08 ? 0.3 : 0.65);
    R.showBand(s.x, s.z, d.angle + Math.PI, 0.015 + d.power * 0.05, col);
  }
});

function endDrag(e, cancelled) {
  const d = state.drag;
  state.drag = null;
  if (!d || state.screen !== 'aim' || state.aimIdx < 0) return;
  if (cancelled) {
    showDefaultAim();
    return;
  }
  if (!d.pulling) {
    // タップ: スタート位置を決める
    const p = R.pickFloor(e.clientX, e.clientY);
    if (!p) return;
    const q = clampToSide(state.aimIdx, p.x, p.z);
    state.pos[state.aimIdx] = q;
    R.placeReady(state.aimIdx, q.x, q.z);
    sound.event({ type: 'place' });
    showDefaultAim();
    return;
  }
  if (d.angle === null || d.power < 0.08) {
    showDefaultAim(); // 引きが弱すぎるときはやり直し
    return;
  }
  state.aims[state.aimIdx] = { angle: d.angle, power: d.power, bank: state.bank ? 1 : 0 };
  nextAimer();
}
canvas.addEventListener('pointerup', (e) => endDrag(e, false));
canvas.addEventListener('pointercancel', (e) => endDrag(e, true));

$('#bank').onclick = () => {
  state.bank = !state.bank;
  $('#bank').textContent = `バンクシュート: ${state.bank ? 'ON' : 'OFF'}`;
  $('#bank').classList.toggle('on', state.bank);
};

const cams = ['battle', 'top'];
$('#btnCam').onclick = () => {
  R.setCamera(cams[(cams.indexOf(R.mode) + 1) % cams.length]);
  if (state.screen === 'aim') R.controls.enabled = !humans().some(Boolean);
};
const speeds = [1, 2, 4, 0.5];
$('#btnSpeed').onclick = () => {
  state.speed = speeds[(speeds.indexOf(state.speed) + 1) % speeds.length];
  $('#btnSpeed').textContent = `×${state.speed}`;
};
$('#btnTrail').onclick = () => {
  R.trailsOn = !R.trailsOn;
  $('#btnTrail').textContent = `軌跡 ${R.trailsOn ? 'ON' : 'OFF'}`;
};
$('#btnSound').onclick = () => {
  sound.unlock();
  sound.setOn(!sound.on);
  $('#btnSound').textContent = `音 ${sound.on ? 'ON' : 'OFF'}`;
};
$('#btnQuit').onclick = backToCustom;
$('#btnNext').onclick = () => {
  if (state.score.some((s) => s >= TARGET)) state.score = [0, 0];
  state.swap = !state.swap;
  startRound();
};
$('#btnBack').onclick = backToCustom;

// ---------- ループ ----------

let last = performance.now();
let lastSize = '';
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
  if (size !== lastSize) {
    lastSize = size;
    R.resize();
  }

  if (state.screen === 'custom') {
    runSolo();
    R.updatePreview(dt);
  } else {
    const w = state.world;
    if (state.screen === 'aim' && !humans().some(Boolean)) {
      state.autoT += dt;
      if (state.autoT > 0.9) launchAll();
    }
    if (state.screen === 'battle' && w) {
      // 物理は自前の刻み幅で進む（当たりそうなときは自動で細かくなる）
      const simDt = Math.min(MAX_SIM_PER_FRAME, dt * TIME_SCALE * state.speed);
      advance(w, simDt);
      if (!state.result) {
        const res = judge(w);
        if (res) onResult(res);
      }
      for (const ev of w.events) {
        R.onEvent(ev);
        sound.event(ev);
      }
      w.events.length = 0;
      if (state.result) {
        state.resultT += dt;
        if (!state.bannerShown && state.resultT > 1.1) showBanner();
      }
      // 長すぎる試合の保険
      if (!state.result && w.t > 300) onResult({ winner: -1, type: 'spin', points: 0 });
      sound.update(w);
    }
    R.update(w, dt * TIME_SCALE * state.speed);
    updateHud();
  }
  requestAnimationFrame(frame);
}

buildCustom();
R.setCamera('preview');
setNames();
requestAnimationFrame(frame);

// デバッグ・自動テスト用
window.__game = { state, R, POINTS };
