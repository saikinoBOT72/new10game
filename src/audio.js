// WebAudio で効果音を合成する（音声ファイルなし）
export class Sound {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.hums = [];
    this.lastHit = 0;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.on ? 0.8 : 0;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (let i = 0; i < 2; i++) this.hums.push(this.makeHum());
    this.grind = this.makeGrind();
  }

  setOn(v) {
    this.on = v;
    if (this.master) this.master.gain.value = v ? 0.8 : 0;
  }

  makeHum() {
    const c = this.ctx;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = c.createGain();
    g.gain.value = 0;
    osc.connect(f).connect(g).connect(this.master);
    osc.start();
    return { osc, g, f };
  }

  makeGrind() {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 3200;
    f.Q.value = 2;
    const g = c.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return { g, f };
  }

  // 毎フレーム: 回転音とレールの音
  update(world) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    let rail = false;
    world?.beys.forEach((b, i) => {
      const h = this.hums[i];
      if (!h) return;
      const w = b.state === 'spin' ? Math.abs(b.w) : 0;
      h.osc.frequency.setTargetAtTime(55 + w * 0.32 + i * 7, t, 0.05);
      h.g.gain.setTargetAtTime(w > 0 ? 0.018 + 0.03 * Math.min(1, w / 900) : 0, t, 0.08);
      if (b.onRail) rail = true;
    });
    if (!world) this.hums.forEach((h) => h.g.gain.setTargetAtTime(0, t, 0.05));
    this.grind.g.gain.setTargetAtTime(rail ? 0.06 : 0, t, 0.04);
  }

  ping(freq, dur, vol, type = 'sine', slide = 0) {
    const c = this.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  burstNoise(dur, vol, freq, q = 1) {
    const c = this.ctx;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  event(ev) {
    if (!this.ctx || !this.on) return;
    const now = this.ctx.currentTime;
    switch (ev.type) {
      case 'hit': {
        if (now - this.lastHit < 0.03) return;
        this.lastHit = now;
        const k = Math.min(1, ev.strength / 0.05);
        this.burstNoise(0.06 + 0.1 * k, 0.15 + 0.5 * k, ev.same ? 2600 : 1800, 1.5);
        this.ping(ev.same ? 2200 + Math.random() * 600 : 1500, 0.12 + 0.2 * k, 0.05 + 0.12 * k, 'triangle');
        break;
      }
      case 'wall':
        this.burstNoise(0.05, 0.08 + 0.2 * Math.min(1, ev.strength / 0.05), 900, 1);
        break;
      case 'place':
        this.ping(880, 0.06, 0.08, 'triangle');
        break;
      case 'lockstep':
        this.ping(2400, 0.08, 0.16, 'square');
        this.ping(1600, 0.12, 0.1, 'square');
        break;
      case 'strain':
        this.ping(3000 + ev.stress * 800, 0.05, 0.08, 'square');
        break;
      case 'dash':
        this.burstNoise(0.3, 0.35, 3800, 0.9);
        this.ping(700, 0.25, 0.08, 'sawtooth', 2.2);
        break;
      case 'burst':
        this.burstNoise(0.5, 0.9, 1200, 0.6);
        this.ping(900, 0.5, 0.25, 'sawtooth', 0.25);
        break;
      case 'over':
      case 'xtreme':
        this.burstNoise(0.35, 0.5, 600, 0.8);
        this.ping(ev.type === 'xtreme' ? 520 : 380, 0.4, 0.2, 'square', 0.4);
        break;
      case 'down':
        this.ping(260, 0.3, 0.12, 'triangle', 0.6);
        break;
      case 'launch':
        this.burstNoise(0.4, 0.5, 2400, 0.7);
        break;
      case 'finish':
        [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.ping(f, 0.25, 0.12, 'square'), i * 90));
        break;
      default:
    }
  }
}
