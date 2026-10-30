// Leitura dos cabeçalhos de MP4/MOV sem ffprobe (Fase 5, D10 e MID-14), com vídeos montados em
// código pelo `sampleMp4` (nada é baixado).
import { describe, expect, it } from 'vitest';

import { PermanentMediaError } from './image-processor.js';
import { sampleMp4 } from './mp4-sample.js';
import { MAX_MOOV_BYTES, probeVideo } from './video-probe.js';

function reader(file: Buffer) {
  const reads: { start: number; length: number }[] = [];
  return {
    reads,
    read: (start: number, length: number) => {
      reads.push({ start, length });
      return Promise.resolve(file.subarray(start, start + length));
    },
  };
}

function probe(file: Buffer) {
  return probeVideo(reader(file).read, file.length);
}

describe('probeVideo', () => {
  it('[MID-14] MP4 de 90 s: duração, tamanho e container', async () => {
    await expect(probe(sampleMp4({ durationS: 90 }))).resolves.toEqual({
      container: 'mp4',
      durationS: 90,
      width: 720,
      height: 1280,
    });
  });

  it('[MID-14] .mov do iPhone (marca qt) com o moov no fim do arquivo', async () => {
    const file = sampleMp4({
      durationS: 42.5,
      brand: 'qt  ',
      moovAtEnd: true,
      width: 1080,
      height: 1920,
      mdatBytes: 50_000,
    });
    await expect(probe(file)).resolves.toEqual({
      container: 'quicktime',
      durationS: 42.5,
      width: 1080,
      height: 1920,
    });
  });

  it('nunca lê o vídeo inteiro: só cabeçalhos e o moov', async () => {
    const file = sampleMp4({ durationS: 30, moovAtEnd: true, mdatBytes: 2_000_000 });
    const { reads, read } = reader(file);
    await probeVideo(read, file.length);
    const total = reads.reduce((sum, item) => sum + item.length, 0);
    expect(total).toBeLessThan(2_000);
  });

  it('matriz girada 90° (vídeo de celular gravado deitado): troca largura e altura', async () => {
    await expect(
      probe(sampleMp4({ durationS: 10, width: 1920, height: 1080, rotate90: true })),
    ).resolves.toMatchObject({ width: 1080, height: 1920 });
  });

  it('caixas na versão 1 (64 bits) e MP4 fragmentado (duração no mehd)', async () => {
    await expect(probe(sampleMp4({ durationS: 91, version1: true }))).resolves.toMatchObject({
      durationS: 91,
    });
    await expect(probe(sampleMp4({ durationS: 12.25, fragmented: true }))).resolves.toMatchObject({
      durationS: 12.25,
    });
  });

  it.each([
    ['HTML disfarçado', Buffer.from('<!doctype html><html><body>oi</body></html>')],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1])],
    ['vazio', Buffer.alloc(0)],
    ['só o ftyp', sampleMp4({ durationS: 5 }).subarray(0, 24)],
  ])('[MID-14] %s → PermanentMediaError (não é vídeo)', async (_name, file) => {
    await expect(probe(file)).rejects.toBeInstanceOf(PermanentMediaError);
  });

  it('sem trilha de vídeo, sem duração ou com moov cortado → PermanentMediaError', async () => {
    await expect(probe(sampleMp4({ durationS: 5, withoutVideoTrack: true }))).rejects.toThrow(
      /sem trilha de vídeo/,
    );
    await expect(probe(sampleMp4({ durationS: 0 }))).rejects.toThrow(/duração desconhecida/);
    const file = sampleMp4({ durationS: 5, moovAtEnd: true });
    await expect(probeVideo(reader(file).read, file.length - 10)).rejects.toBeInstanceOf(
      PermanentMediaError,
    );
  });

  it('moov declarado com mais de 32 MB é recusado sem ser lido', async () => {
    const file = sampleMp4({ durationS: 5 });
    // Reescreve o tamanho do moov (logo depois do ftyp de 24 bytes) como gigante.
    const huge = Buffer.from(file);
    huge.writeUInt32BE(MAX_MOOV_BYTES + 100, 24);
    const { reads, read } = reader(huge);
    await expect(probeVideo(read, MAX_MOOV_BYTES * 2)).rejects.toThrow(/moov grande demais/);
    expect(reads.every((item) => item.length <= 32)).toBe(true);
  });

  it('a localização do container (udta/©xyz) não atrapalha a leitura (o passthrough a copia, A-21)', async () => {
    const file = sampleMp4({ durationS: 15, location: '+37.3349-122.0090/' });
    expect(file.includes(Buffer.from('+37.3349-122.0090/', 'latin1'))).toBe(true);
    await expect(probe(file)).resolves.toMatchObject({ durationS: 15 });
  });
});
