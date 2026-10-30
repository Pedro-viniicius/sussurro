// `pnpm --filter @sussurro/worker seed:media` (depois do `pnpm build`): grava no S3 do .env
// (SeaweedFS do compose) imagens de exemplo para as fotos `ready` cujo objeto ainda não existe,
// como as do `pnpm db:seed` (A-08). Sem isso o feed do seed mostraria fotos quebradas no app.
// Gera degradês com o sharp (nada é baixado). Nunca em produção. (Fase 5) Reels do seed: o poster
// (degradê 9:16) e um MP4 de exemplo montado em código, com a estrutura certa mas sem imagem (não
// toca); para assistir, publique um vídeo pelo app.
import { createHash } from 'node:crypto';

import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createDb, eq, postMedia } from '@sussurro/db';
import sharp from 'sharp';

import { loadRootEnvFile } from '../config/env-file.js';
import { loadWorkerEnv } from '../config/env.schema.js';
import { createS3Client, S3ObjectStorage } from '../infra/storage.js';
import { FULL_WIDTH, JPEG_QUALITY, POSTER_WIDTH, THUMB_WIDTH } from '../media/image-processor.js';
import { sampleMp4 } from '../media/mp4-sample.js';

/** Cor pastel estável por id (cada post fica com a sua). */
function pastel(seed: string, offset: number): string {
  const hash = createHash('sha256').update(seed).digest();
  const channel = (index: number) => 150 + ((hash[(index + offset) % hash.length] ?? 0) % 90);
  return `rgb(${String(channel(0))},${String(channel(1))},${String(channel(2))})`;
}

/** Degradê em JPEG; proporção 4:5 (post do protótipo) ou 16:9 de altura (poster do reel, 9:16). */
async function placeholder(seed: string, width: number, ratio = 5 / 4): Promise<Buffer> {
  const height = Math.round(width * ratio);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">` +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="${pastel(seed, 0)}"/><stop offset="1" stop-color="${pastel(seed, 7)}"/>` +
    '</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>';
  return sharp(Buffer.from(svg)).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

loadRootEnvFile();
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('[seed:media] recusado: NODE_ENV=production.\n');
  process.exit(1);
}
const env = loadWorkerEnv(process.env);
const client = createS3Client({
  region: env.AWS_REGION,
  bucket: env.S3_BUCKET_MEDIA,
  endpoint: env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});
const storage = new S3ObjectStorage(client, env.S3_BUCKET_MEDIA);
const handle = createDb(env.DATABASE_URL, { applicationName: 'sussurro-seed-media', max: 1 });

async function exists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET_MEDIA, Key: key }));
    return true;
  } catch {
    return false;
  }
}

try {
  const media = await handle.db
    .select({
      id: postMedia.id,
      kind: postMedia.kind,
      full: postMedia.storageKey,
      thumb: postMedia.thumbKey,
      durationS: postMedia.durationS,
    })
    .from(postMedia)
    .where(eq(postMedia.status, 'ready'));
  let created = 0;
  for (const item of media) {
    if (item.kind === 'video') {
      // Reel (Fase 5): poster 9:16 e um MP4 de exemplo (estrutura válida, mas não toca).
      if (item.thumb !== null && !(await exists(item.thumb))) {
        await storage.put(
          item.thumb,
          await placeholder(item.id, POSTER_WIDTH, 16 / 9),
          'image/jpeg',
        );
        created += 1;
      }
      if (item.full !== null && !(await exists(item.full))) {
        const video = sampleMp4({ durationS: item.durationS ?? 10, width: 720, height: 1280 });
        await storage.put(item.full, video, 'video/mp4');
        created += 1;
      }
      continue;
    }
    for (const [key, width] of [
      [item.full, FULL_WIDTH],
      [item.thumb, THUMB_WIDTH],
    ] as const) {
      if (key !== null && !(await exists(key))) {
        await storage.put(key, await placeholder(item.id, width), 'image/jpeg');
        created += 1;
      }
    }
  }
  process.stdout.write(
    `[seed:media] ${String(created)} objetos criados para ${String(media.length)} mídias prontas\n`,
  );
} finally {
  await handle.close();
  client.destroy();
}
