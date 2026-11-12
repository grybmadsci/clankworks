/** URL flags for isolating subsystems while debugging, e.g. `?no=post,mesh`. */
const off = new Set((new URLSearchParams(location.search).get('no') ?? '').split(',').filter(Boolean));
export const enabled = (feature: 'post' | 'mesh' | 'fluid' | 'particles' | 'entities' | 'sim' | 'readback' | 'meshfx' | 'lamps' | 'laser') => !off.has(feature);
