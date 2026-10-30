// Gera as imagens de exemplo do catálogo (/dev/catalog), no estilo da ilustração de p03: céu, sol e
// ondas em cores chapadas (ux.md §6.15). Só entram no catálogo, que não existe em produção.
// Uso: pnpm --filter @sussurro/mobile generate-catalog-images
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const outDir = fileURLToPath(new URL('../assets/catalog/', import.meta.url));

const W = 540;
const H = 675; // 4:5, a proporção do post de foto

/** Paisagem: fundo, sol e três ondas (cores do protótipo, aproximadas). */
const scenes = [
  {
    file: 'paisagem-azul.png',
    sky: '#D7E5FB',
    sun: { color: '#FDF3D6', x: 420, y: 190, r: 64 },
    waves: ['#A9C4EE', '#6F95D6', '#3A5DAF'],
  },
  {
    file: 'paisagem-verde.png',
    sky: '#E2F0FB',
    sun: { color: '#FFD45C', x: 400, y: 170, r: 52 },
    waves: ['#B8DE8B', '#7CBF57', '#3F8A39'],
  },
  {
    file: 'paisagem-areia.png',
    sky: '#FDE7D7',
    sun: { color: '#FF9466', x: 150, y: 210, r: 58 },
    waves: ['#58C3E6', '#9ADFF2', '#F3DCAE'],
  },
];

function wave(y, amplitude, color) {
  return `<path d="M0 ${y} C ${W * 0.25} ${y - amplitude}, ${W * 0.5} ${y + amplitude}, ${W} ${y - amplitude / 2} L ${W} ${H} L 0 ${H} Z" fill="${color}"/>`;
}

function svg(scene) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${scene.sky}"/>
  <circle cx="${scene.sun.x}" cy="${scene.sun.y}" r="${scene.sun.r}" fill="${scene.sun.color}"/>
  ${wave(H * 0.58, 70, scene.waves[0])}
  ${wave(H * 0.72, 50, scene.waves[1])}
  ${wave(H * 0.85, 30, scene.waves[2])}
</svg>`;
}

await mkdir(outDir, { recursive: true });
for (const scene of scenes) {
  await sharp(Buffer.from(svg(scene)))
    .png({ palette: true })
    .toFile(`${outDir}${scene.file}`);
  console.log(`gerado: assets/catalog/${scene.file} (${W}x${H})`);
}
