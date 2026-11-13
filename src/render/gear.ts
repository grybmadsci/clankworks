import * as THREE from 'three/webgpu';

/** A cog wheel facing +z: teeth around a rim, a hub hole, and lightening holes between the spokes (if it's big enough). */
export function gearGeometry(radius: number, teeth: number, depth: number) {
  const shape = new THREE.Shape();
  const root = radius * 0.8;
  const step = (Math.PI * 2) / teeth;
  for (let n = 0; n < teeth; n++) {
    const a = n * step;
    const pts: [number, number][] = [[root, a], [radius, a + step * 0.12], [radius, a + step * 0.42], [root, a + step * 0.55]];
    pts.forEach(([r, ang], m) => {
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      if (n === 0 && m === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius * 0.16, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  if (radius > 0.1) {
    for (let n = 0; n < 5; n++) {
      const a = (n / 5) * Math.PI * 2;
      const h = new THREE.Path();
      h.absarc(Math.cos(a) * radius * 0.48, Math.sin(a) * radius * 0.48, radius * 0.15, 0, Math.PI * 2, true);
      shape.holes.push(h);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 1, curveSegments: 6 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}
