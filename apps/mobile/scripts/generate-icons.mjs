// Gera ícone, adaptive icon e splash a partir do SVG exato do <Logo> (ux.md §4.1 e §6.12).
// Uso: pnpm --filter @sussurro/mobile generate-icons
// Também serve de verificação de que o sharp (binário nativo) funciona no Windows (ADR 0001).
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { logoMarkSvg } from '@sussurro/ui/logo-geometry';
import sharp from 'sharp';

// A geometria vem de packages/ui (só TypeScript sem dependências; o Node 26 lê .ts nativamente).

const BLUE = '#0066FF';
const outDir = fileURLToPath(new URL('../assets/images/', import.meta.url));

/** Símbolo onBrand centralizado num quadrado, ocupando `scale` da largura. */
async function render({ file, size, scale, background, monochrome = false }) {
  const markSize = Math.round(size * scale);
  let svg = logoMarkSvg('onBrand', markSize);
  if (monochrome) {
    // Ícone temático do Android: só a silhueta conta (o sistema aplica a cor).
    svg = svg.replaceAll('#B3D1FF', '#FFFFFF');
  }
  const mark = await sharp(Buffer.from(svg)).png().toBuffer();
  const offset = Math.round((size - markSize) / 2);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, top: offset, left: offset }])
    .png()
    .toFile(`${outDir}${file}`);
  console.log(`gerado: assets/images/${file} (${size}x${size})`);
}

await mkdir(outDir, { recursive: true });
// Ícone do app: símbolo onBrand sobre quadrado azul (p04 "Ícone do app").
await render({ file: 'icon.png', size: 1024, scale: 0.6, background: BLUE });
// Android adaptive icon: o sistema recorta ~66% centrais; fundo azul vem do app.config.ts.
await render({ file: 'adaptive-icon.png', size: 1024, scale: 0.42 });
await render({ file: 'adaptive-icon-monochrome.png', size: 1024, scale: 0.42, monochrome: true });
// Splash: símbolo sobre fundo transparente; o azul é o backgroundColor do expo-splash-screen.
await render({ file: 'splash-icon.png', size: 512, scale: 0.9 });
