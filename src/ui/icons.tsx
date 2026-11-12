/**
 * Line icons on a 24×24 grid, used in the toolbar and layer panel and (via cursorFor) as the
 * canvas cursor for each tool. `fill` paths are filled instead of stroked.
 */
const ICONS: Record<string, { d: string; fill?: string }> = {
  select: { d: '', fill: 'M5 2.5 L19 13 L12.6 13.9 L16.2 20.8 L13.4 22.2 L9.8 15.2 L5 19.5 Z' },
  dig: { d: 'M3.5 9.5 Q12 2.5 20.5 9.5 M12 6.3 L6.5 21.5' },
  cancel: { d: 'M4 15.5 L12.5 7 L19 13.5 L12.5 20 H8.5 Z M8.5 11 L15 17.5 M12.5 20 H20.5' },
  scrap: { d: 'M14.5 3.2 A5 5 0 0 0 11.3 10.3 L3.5 18.1 L5.9 20.5 L13.7 12.7 A5 5 0 0 0 20.8 9.5 L17.6 10.4 L15.3 8.7 L15.6 5.4 Z' },
  strut: { d: 'M6 3 H18 M6 21 H18 M9.5 3 V21 M14.5 3 V21 M9.5 7 L14.5 11 M14.5 11 L9.5 15 M9.5 15 L14.5 19' },
  smelter: { d: 'M4 21 V9 H17 V21 Z M7.5 21 V15.5 H13.5 V21 M14 9 V3.5 H17 V9 M10.5 14 C8.5 12.5 10 11 10.5 10 C12.5 11.5 12.5 13 10.5 14 Z' },
  drone: { d: 'M9 10 H15 V14 H9 Z M9 10 L6.5 7.5 M15 10 L17.5 7.5 M9 14 L6.5 16.5 M15 14 L17.5 16.5 M3 6.5 H10 M14 6.5 H21 M3 17.5 H10 M14 17.5 H21' },
  // Resources (scrap is a nut; 'scrap' above is the Scrap tool's wrench)
  ore: { d: 'M10 4.5 L12 11 L20 11 M12 11 L9 19.5', fill: 'M6 9 L10 4.5 L16 5.5 L20 11 L17 18.5 L9 19.5 L4 14.5 Z' },
  nut: { d: 'M12 3 L19.8 7.5 V16.5 L12 21 L4.2 16.5 V7.5 Z M15 12 A3 3 0 1 1 9 12 A3 3 0 0 1 15 12 Z' },
  plates: { d: 'M3 15.5 L12 19.5 L21 15.5 M3 12 L12 16 L21 12 L12 8 Z' },
  square: { d: 'M5 5 H19 V19 H5 Z' },
  circle: { d: 'M19 12 A7 7 0 1 1 5 12 A7 7 0 0 1 19 12 Z' },
  normal: { d: 'M2 12 C5 6 19 6 22 12 C19 18 5 18 2 12 Z M12 15 A3 3 0 1 0 12 9 A3 3 0 0 0 12 15 Z' },
  heat: { d: 'M14 14.2 V5 A2 2 0 0 0 10 5 V14.2 A4 4 0 1 0 14 14.2 Z M12 9 V16' },
  oxygen: { d: 'M12 9 A4 4 0 1 1 4 9 A4 4 0 0 1 12 9 Z M20.5 14 A3 3 0 1 1 14.5 14 A3 3 0 0 1 20.5 14 Z M13 20.5 A2 2 0 1 1 9 20.5 A2 2 0 0 1 13 20.5 Z' },
  integrity: { d: 'M3 6 H21 V18 H3 Z M11 6 L13 10 L10 13 L12.5 18' },
  material: { d: 'M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 V21' },
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const icon = ICONS[name];
  if (!icon) return null;
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {icon.fill && <path d={icon.fill} fill="currentColor" stroke="currentColor" strokeWidth={0.8} strokeLinejoin="round" />}
      {/* Over a filled shape the strokes are facet lines, drawn dark. */}
      {icon.d && <path d={icon.d} fill="none" stroke={icon.fill ? 'rgba(0,0,0,0.45)' : 'currentColor'} strokeWidth={icon.fill ? 1.3 : 1.8} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/**
 * A CSS cursor drawing a tool's icon (light, with a dark outline so it reads on any rock), with
 * the hot spot where the tool acts: the arrow's tip, or the centre for brushes and placements.
 */
export function cursorFor(name: string, color = '#ffe2a8') {
  const icon = ICONS[name];
  if (!icon) return 'default';
  const layer = (stroke: string, w: number) =>
    (icon.d ? `<path d="${icon.d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>` : '') +
    (icon.fill ? `<path d="${icon.fill}" fill="${stroke === color ? color : 'none'}" stroke="${stroke}" stroke-width="${w * 0.6}" stroke-linejoin="round"/>` : '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="-2 -2 28 28">${layer('#120d08', 4.5)}${layer(color, 2)}</svg>`;
  const hot = name === 'select' ? '7 4' : '14 14';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot}, crosshair`;
}
