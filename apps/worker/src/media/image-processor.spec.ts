import { describe, expect, it } from 'vitest';

import { detectImageFormat, PermanentMediaError, processPostImage } from './image-processor.js';

describe('detectImageFormat (MID-04)', () => {
  it('reconhece JPEG, PNG e WebP pelos magic bytes', () => {
    expect(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpeg');
    expect(
      detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('png');
    expect(detectImageFormat(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('webp');
  });

  it.each([
    ['HTML', '<!doctype html><html></html>'],
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['XML com BOM', '﻿<?xml version="1.0"?><svg/>'],
    ['GIF', 'GIF89a......'],
    ['RIFF que não é WebP (AVI)', 'RIFF\x10\x00\x00\x00AVI LIST'],
    ['vazio', ''],
  ])('%s → não é imagem aceita', (_name, content) => {
    expect(detectImageFormat(Buffer.from(content, 'latin1'))).toBeNull();
  });

  it('processPostImage recusa sem chegar ao decodificador', async () => {
    await expect(
      processPostImage(Buffer.from('<svg/>'), 'image/jpeg', { maxPixels: 1_000_000 }),
    ).rejects.toBeInstanceOf(PermanentMediaError);
  });
});
