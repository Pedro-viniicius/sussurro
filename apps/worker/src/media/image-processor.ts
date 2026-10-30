import sharp, { type Metadata, type Sharp } from 'sharp';

/** Formatos aceitos (os mesmos de `IMAGE_MIME_TYPES` no `packages/shared`). */
export type ImageFormat = 'jpeg' | 'png' | 'webp';

export const MIME_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Saídas (ADR 0009): `full` com 1080 px de largura e `thumb` com 360 px, JPEG q82. */
export const FULL_WIDTH = 1080;
export const THUMB_WIDTH = 360;
export const JPEG_QUALITY = 82;
/** Avatar: quadrado de 400 px (o maior uso é o perfil, 86 pt × 3). */
export const AVATAR_SIZE = 400;

/**
 * Falha que não adianta repetir (arquivo que não é imagem, corrompido ou grande demais): a mídia
 * vira `failed` na hora, sem esperar as 3 tentativas.
 */
export class PermanentMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMediaError';
  }
}

/**
 * Tipo real pelos magic bytes (MID-04), sem confiar no `Content-Type` declarado: JPEG
 * (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`) e WebP (`RIFF....WEBP`). HTML, SVG e qualquer outra
 * coisa dão `null` e nunca chegam ao decodificador.
 */
export function detectImageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, index) => bytes[index] === byte)) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface ImageLimits {
  /** Teto de pixels do original (MID-06). */
  maxPixels: number;
}

/**
 * Confere o tipo e o tamanho em pixels antes de decodificar (bomba de descompressão, MID-06): o
 * cabeçalho já diz as dimensões, e o `limitInputPixels` do sharp é a segunda barreira.
 */
async function openChecked(
  input: Buffer,
  declaredMime: string,
  limits: ImageLimits,
): Promise<Sharp> {
  const format = detectImageFormat(input);
  if (format === null) {
    throw new PermanentMediaError('O arquivo não é JPEG, PNG nem WebP (magic bytes)');
  }
  if (MIME_BY_FORMAT[format] !== declaredMime) {
    throw new PermanentMediaError(
      `Tipo declarado ${declaredMime} diferente do real ${MIME_BY_FORMAT[format]}`,
    );
  }
  const image = sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'error' });
  let metadata: Metadata;
  try {
    metadata = await image.metadata();
  } catch (error) {
    const message = (error as Error).message;
    throw new PermanentMediaError(
      /pixel limit/i.test(message)
        ? `Imagem acima do limite de ${String(limits.maxPixels)} px (${message})`
        : `Imagem ilegível: ${message}`,
    );
  }
  const { width, height } = metadata;
  if (width === 0 || height === 0 || width * height > limits.maxPixels) {
    throw new PermanentMediaError(
      `Imagem de ${String(width)}×${String(height)} px acima do limite de ${String(limits.maxPixels)} px`,
    );
  }
  // Gira pela orientação EXIF e remove a tag. Transparência vira fundo branco (o JPEG não tem alfa).
  return image.rotate().flatten({ background: '#ffffff' });
}

/**
 * Re-encoda em JPEG. O sharp não copia nenhum metadado para a saída (EXIF, GPS, XMP, IPTC, ICC)
 * a não ser que se peça `keepMetadata`/`withMetadata`, o que nunca é feito aqui (ADR 0009, MID-05).
 */
async function encode(pipeline: Sharp): Promise<ProcessedImage> {
  try {
    const { data, info } = await pipeline
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    throw new PermanentMediaError(`Falha ao processar a imagem: ${(error as Error).message}`);
  }
}

/** Foto de post: `full` (1080 px) e `thumb` (360 px), sem aumentar imagem menor. */
export async function processPostImage(
  input: Buffer,
  declaredMime: string,
  limits: ImageLimits,
): Promise<{ full: ProcessedImage; thumb: ProcessedImage }> {
  const base = await openChecked(input, declaredMime, limits);
  const full = await encode(base.clone().resize({ width: FULL_WIDTH, withoutEnlargement: true }));
  const thumb = await encode(base.clone().resize({ width: THUMB_WIDTH, withoutEnlargement: true }));
  return { full, thumb };
}

/** Foto de perfil: quadrado de 400 px recortado no centro (2.4). */
export async function processAvatarImage(
  input: Buffer,
  declaredMime: string,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  const base = await openChecked(input, declaredMime, limits);
  return encode(base.resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' }));
}

/** Poster do reel: 720 px de largura, como o vídeo convertido pelo MediaConvert (ADR 0006). */
export const POSTER_WIDTH = 720;

/**
 * Poster do reel enviado pelo app (passthrough, Fase 5): o mesmo pipeline das fotos (magic bytes,
 * teto de pixels, rotação e nenhum metadado na saída), com 720 px de largura sem aumentar.
 */
export async function processPosterImage(
  input: Buffer,
  declaredMime: string,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  const base = await openChecked(input, declaredMime, limits);
  return encode(base.resize({ width: POSTER_WIDTH, withoutEnlargement: true }));
}
