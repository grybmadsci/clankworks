// Synthesized scrapbot chirps. The AudioContext is created lazily on the first user gesture.
let ctx: AudioContext | null = null;

export function unlockAudio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

/** A short warbling robot chirp; `mood` shifts pitch (positive = cheerful, negative = panic). */
export function chirp(mood = 0, notes = 3) {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = mood < 0 ? 'sawtooth' : 'square';
  osc.connect(gain);
  const base = 520 + mood * 160 + Math.random() * 120;
  for (let n = 0; n < notes; n++) {
    const t = now + n * 0.07;
    osc.frequency.setValueAtTime(base * (1 + (Math.random() - 0.3) * 0.6), t);
    osc.frequency.exponentialRampToValueAtTime(base * (mood < 0 ? 0.6 : 1.5), t + 0.06);
  }
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + notes * 0.07 + 0.05);
  osc.start(now);
  osc.stop(now + notes * 0.07 + 0.1);
}

/** Low thump for cave-ins and the drill. */
export function rumble(strength = 1) {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(70, now);
  osc.frequency.exponentialRampToValueAtTime(28, now + 0.6);
  gain.gain.setValueAtTime(Math.min(0.25, 0.08 * strength), now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.85);
}

/** Groaning rock: a detuned low sawtooth bending downward, for cracking ceilings. */
export function creak(strength = 1) {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const len = 0.35 + Math.random() * 0.4;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  const f = 90 + Math.random() * 70;
  osc.frequency.setValueAtTime(f, now);
  osc.frequency.linearRampToValueAtTime(f * (0.7 + Math.random() * 0.2), now + len);
  filter.type = 'bandpass';
  filter.frequency.value = 380;
  filter.Q.value = 3;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.min(0.12, 0.04 * strength), now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + len);
  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + len + 0.05);
}

/** Two-tone klaxon for a new cave-in warning. */
export function alarm() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  for (let n = 0; n < 4; n++) osc.frequency.setValueAtTime(n % 2 ? 520 : 690, now + n * 0.18);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
  gain.gain.setValueAtTime(0.05, now + 0.68);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.8);
}
