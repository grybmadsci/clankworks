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

/** Low thump for cave-ins and blasts. */
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
