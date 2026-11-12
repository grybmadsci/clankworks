import { wgslFn as wgslFnTyped } from 'three/tsl';

const wgslFn = wgslFnTyped as (code: string, includes?: unknown[]) => any;

/**
 * Procedural rock surfaces, evaluated per fragment in world space. Everything is 3D, so the
 * cutaway face and the extruded walls share one continuous texture with no triplanar seams.
 */
const hash3 = wgslFn(/* wgsl */ `
fn hash3(q: vec3i) -> u32 {
  var h = (u32(q.x) * 0x8da6b343u) ^ (u32(q.y) * 0xd8163841u) ^ (u32(q.z) * 0xcb1ab31fu);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
`);

/** Gradient noise in roughly [-1, 1], quintic fade so there are no visible lattice creases. */
const gnoise3 = wgslFn(/* wgsl */ `
fn gnoise3(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var v: array<f32, 8>;
  for (var c = 0; c < 8; c++) {
    let o = vec3i(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    let h = hash3(i + o);
    // Unit-ish gradient from the hash: three signed components.
    let g = vec3f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 127.5 - 1.0;
    v[c] = dot(g, f - vec3f(o));
  }
  let x0 = mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y);
  let x1 = mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y);
  return mix(x0, x1, u.z) * 1.6;
}
`, [hash3]);

/** Fractal sum with a rotation between octaves so the layers don't line up on the axes. */
const fbm3 = wgslFn(/* wgsl */ `
fn fbm3(p: vec3f, octaves: i32) -> f32 {
  let r = mat3x3f(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  var q = p;
  var a = 0.5;
  var s = 0.0;
  for (var o = 0; o < octaves; o++) {
    s += a * gnoise3(q);
    q = r * q * 2.03 + vec3f(1.7, 9.2, 4.1);
    a *= 0.5;
  }
  return s;
}
`, [gnoise3]);

/** Worley cells: x = distance to nearest feature, y = second nearest, z = nearest cell's id in [0, 1). */
const worley3 = wgslFn(/* wgsl */ `
fn worley3(p: vec3f) -> vec3f {
  let i = vec3i(floor(p));
  let f = fract(p);
  var d1 = 9.0;
  var d2 = 9.0;
  var id = 0u;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3i(x, y, z);
        let h = hash3(i + o);
        let j = vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0;
        let d = length(vec3f(o) + j * 0.85 + 0.075 - f);
        if (d < d1) { d2 = d1; d1 = d; id = h; } else if (d < d2) { d2 = d; }
      }
    }
  }
  return vec3f(d1, d2, f32(id >> 8u) / 16777216.0);
}
`, [hash3]);

/**
 * Albedo (rgb, linear) and a height in world units (w) for one material at world position p.
 * Materials: 1 dirt, 2 granite, 3 copper ore, 4 ice, 5 bedrock, 6 rubble, 7 junk.
 * Too heavy for software adapters; materials.ts has a cheap 2D stand-in for the low tier.
 */
export const rockSurface = wgslFn(/* wgsl */ `
fn rockSurface(p: vec3f, mat: u32) -> vec4f {
  let broad = fbm3(p * 0.35, 2);
  let mid = fbm3(p * 1.7 + 3.1, 5);
  let fine = gnoise3(p * 23.0);
  var col: vec3f;
  var h = mid * 0.012 + fine * 0.002;

  if (mat == 2u) {
    // Granite: fine grey crystalline grain with sparse feldspar and biotite.
    let w = worley3(p * 40.0);
    let feldspar = vec3f(0.2, 0.16, 0.14);
    let quartz = vec3f(0.17, 0.17, 0.175);
    let biotite = vec3f(0.04, 0.04, 0.04);
    let crystal = select(select(quartz, feldspar, w.z < 0.3), biotite, w.z > 0.9);
    col = mix(vec3f(0.15, 0.145, 0.14), crystal, 0.5) * (1.0 + mid * 0.22 + broad * 0.12 + fine * 0.06);
    h += (w.y - w.x) * 0.003;
  } else if (mat == 3u) {
    // Copper ore: rusty, iron-stained host rock with thin malachite veins and native-copper flecks.
    col = mix(vec3f(0.13, 0.075, 0.045), vec3f(0.24, 0.12, 0.05), smoothstep(-0.3, 0.4, mid)) * (1.0 + fine * 0.1);
    let warp = fbm3(p * 1.1 + 7.0, 2);
    let vein = 1.0 - smoothstep(0.0, 0.035, abs(fbm3(p * 0.9 + vec3f(warp * 1.5), 5)));
    col = mix(col, vec3f(0.05, 0.2, 0.12), vein * 0.6);
    let w = worley3(p * 11.0);
    let fleck = (1.0 - smoothstep(0.16, 0.26, w.x)) * step(0.45, w.z);
    col = mix(col, vec3f(0.9, 0.42, 0.14) * (0.8 + w.z * 0.4), fleck);
    h += fleck * 0.006 - vein * 0.003;
  } else if (mat == 4u) {
    // Ice: pale blue, clearer in places, with white fracture lines.
    let w = worley3(p * 3.5);
    let crack = 1.0 - smoothstep(0.0, 0.05, w.y - w.x);
    col = mix(vec3f(0.36, 0.6, 0.72), vec3f(0.62, 0.78, 0.86), mid * 0.5 + 0.5);
    col = mix(col, vec3f(0.85, 0.92, 0.95), crack * 0.7);
    h = -crack * 0.006 + mid * 0.004;
  } else if (mat == 5u) {
    // Bedrock: fine-grained basalt with vesicles.
    let w = worley3(p * 18.0);
    let vesicle = (1.0 - smoothstep(0.08, 0.16, w.x)) * step(0.7, w.z);
    col = vec3f(0.035, 0.033, 0.04) * (1.0 + mid * 0.3 + fine * 0.15) * (1.0 - vesicle * 0.6);
    h -= vesicle * 0.006;
  } else if (mat == 6u) {
    // Rubble: angular broken chunks of mixed rock with dark gaps between them.
    let w = worley3(p * 7.0);
    let chunk = mix(vec3f(0.2, 0.13, 0.08), vec3f(0.28, 0.27, 0.26), w.z);
    let gap = smoothstep(0.0, 0.08, w.y - w.x);
    col = chunk * (0.85 + mid * 0.2) * mix(0.25, 1.0, gap);
    h = gap * 0.02 + mid * 0.004;
  } else if (mat == 7u) {
    // Junk: packed grey-green fill with rusted and oxidised scrap mixed through.
    let w = worley3(p * 9.0);
    let bit = (1.0 - smoothstep(0.18, 0.24, w.x)) * step(0.55, w.z);
    let metal = select(vec3f(0.36, 0.12, 0.04), vec3f(0.12, 0.3, 0.26), w.z > 0.85);
    col = mix(vec3f(0.13, 0.14, 0.1) * (1.0 + mid * 0.25), metal, bit);
    h += bit * 0.008;
  } else {
    // Dirt: compacted soil with organic mottling, darker seams along the bedding, and pebbles.
    col = vec3f(0.2, 0.12, 0.065) * (1.0 + mid * 0.22 + broad * 0.12 + fine * 0.08);
    let seam = smoothstep(0.0, 0.6, fbm3(vec3f(p.x * 0.5, p.y * 2.5, p.z * 0.5), 5));
    col *= 1.0 - seam * 0.2;
    let w = worley3(p * 9.0);
    let pebble = (1.0 - smoothstep(0.2, 0.28, w.x)) * step(0.8, w.z);
    let stone = mix(vec3f(0.12, 0.1, 0.085), vec3f(0.2, 0.15, 0.1), fract(w.z * 7.0));
    col = mix(col, stone * (0.9 + fine * 0.2), pebble);
    h += pebble * (0.3 - w.x) * 0.04;
  }
  return vec4f(max(col, vec3f(0.0)), h);
}
`, [fbm3, gnoise3, worley3]);

/** World-space offset that wobbles material boundaries off the cell grid. */
export const boundaryWarp = wgslFn(/* wgsl */ `
fn boundaryWarp(p: vec3f) -> vec2f {
  return vec2f(fbm3(vec3f(p.xy * 3.0, 0.5), 3), fbm3(vec3f(p.xy * 3.0 + 11.3, 2.5), 3));
}
`, [fbm3]);
