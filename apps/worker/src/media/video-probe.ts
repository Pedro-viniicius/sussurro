import { PermanentMediaError } from './image-processor.js';

/**
 * Leitura dos cabeçalhos de um vídeo MP4 ou QuickTime (ISO BMFF), sem binário externo (ffprobe):
 * confere que o arquivo é mesmo um container de vídeo (magic bytes `ftyp`) e tira a duração (`mvhd`)
 * e o tamanho de exibição (`tkhd`, já com a rotação aplicada). O vídeo nunca é baixado inteiro: só
 * os cabeçalhos das caixas do primeiro nível e a caixa `moov` (onde ficam os metadados das trilhas),
 * por intervalo de bytes. Serve à regra dos 90 s (D10) e barra arquivos que não são vídeo antes de
 * o MediaConvert cobrar por eles.
 */
export interface VideoProbe {
  /** `quicktime` quando a marca principal é `qt  ` (o `.mov` do iPhone); senão `mp4`. */
  container: 'mp4' | 'quicktime';
  durationS: number;
  /** Tamanho de exibição da trilha de vídeo (com a rotação do `tkhd` aplicada). */
  width: number;
  height: number;
}

/** Lê até `length` bytes a partir de `start` (menos no fim do arquivo). */
export type RangeReader = (start: number, length: number) => Promise<Buffer>;

/** Caixas do primeiro nível lidas no máximo (um arquivo bem formado tem menos de 10). */
const MAX_TOP_LEVEL_BOXES = 64;
/** `moov` maior que isto não é de um vídeo de 90 s (tem centenas de KB): recusa sem ler. */
export const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** Profundidade e quantidade de caixas percorridas dentro do `moov`. */
const MAX_CHILD_BOXES = 4096;

interface BoxHeader {
  type: string;
  /** Tamanho total da caixa, com o cabeçalho. */
  size: number;
  headerSize: number;
}

function invalid(reason: string): PermanentMediaError {
  return new PermanentMediaError(`O arquivo não é um vídeo MP4/MOV válido: ${reason}`);
}

/**
 * Cabeçalho de uma caixa em `buffer[offset]`. `remaining` é quanto do arquivo (ou da caixa-mãe)
 * sobra a partir dela: tamanho 0 quer dizer "até o fim".
 */
function readBoxHeader(buffer: Buffer, offset: number, remaining: number): BoxHeader {
  if (offset + 8 > buffer.length) {
    throw invalid('caixa truncada');
  }
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (offset + 16 > buffer.length) {
      throw invalid('caixa truncada');
    }
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalid('caixa grande demais');
    }
    size = Number(large);
    headerSize = 16;
  } else if (size32 === 0) {
    size = remaining;
  }
  if (size < headerSize || size > remaining) {
    throw invalid(`caixa ${JSON.stringify(type)} com tamanho inválido`);
  }
  return { type, size, headerSize };
}

interface ChildBox {
  type: string;
  /** Início do conteúdo (depois do cabeçalho) e fim da caixa, no buffer. */
  start: number;
  end: number;
}

/** Filhas diretas da caixa que ocupa `buffer[start, end)`. */
function children(buffer: Buffer, start: number, end: number, budget: { left: number }) {
  const list: ChildBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    budget.left -= 1;
    if (budget.left < 0) {
      throw invalid('caixas demais');
    }
    const header = readBoxHeader(buffer, offset, end - offset);
    list.push({ type: header.type, start: offset + header.headerSize, end: offset + header.size });
    offset += header.size;
  }
  return list;
}

function find(list: readonly ChildBox[], type: string): ChildBox | undefined {
  return list.find((box) => box.type === type);
}

/** Inteiro sem sinal de 32 ou 64 bits (`version` 0 ou 1 das caixas "full"). */
function readUint(buffer: Buffer, offset: number, wide: boolean, end: number): number {
  if (offset + (wide ? 8 : 4) > end) {
    throw invalid('caixa truncada');
  }
  return wide ? Number(buffer.readBigUInt64BE(offset)) : buffer.readUInt32BE(offset);
}

/** `mvhd`: escala de tempo e duração do filme. */
function movieHeader(buffer: Buffer, box: ChildBox): { timescale: number; duration: number } {
  const wide = buffer.readUInt8(box.start) === 1;
  const fields = box.start + 4 + (wide ? 16 : 8);
  const timescale = readUint(buffer, fields, false, box.end);
  const duration = readUint(buffer, fields + 4, wide, box.end);
  // Duração "desconhecida" (todos os bits ligados) conta como 0: vale a do `mehd`.
  const unknown = wide ? duration >= Number.MAX_SAFE_INTEGER : duration === 0xffffffff;
  return { timescale, duration: unknown ? 0 : duration };
}

/** `tkhd`: tamanho de exibição (ponto fixo 16.16) e se a matriz gira 90° ou 270°. */
function trackSize(buffer: Buffer, box: ChildBox): { width: number; height: number } {
  const wide = buffer.readUInt8(box.start) === 1;
  const matrix = box.start + 4 + (wide ? 32 : 20) + 16;
  const sizeAt = matrix + 36;
  if (sizeAt + 8 > box.end) {
    throw invalid('tkhd truncado');
  }
  const a = buffer.readInt32BE(matrix);
  const d = buffer.readInt32BE(matrix + 16);
  const width = Math.round(buffer.readUInt32BE(sizeAt) / 65536);
  const height = Math.round(buffer.readUInt32BE(sizeAt + 4) / 65536);
  const rotated = a === 0 && d === 0;
  return rotated ? { width: height, height: width } : { width, height };
}

/** Tipo da trilha (`vide`, `soun`…), pelo `hdlr` dentro do `mdia`. */
function handlerOf(buffer: Buffer, trak: ChildBox, budget: { left: number }): string | undefined {
  const mdia = find(children(buffer, trak.start, trak.end, budget), 'mdia');
  if (mdia === undefined) {
    return undefined;
  }
  const hdlr = find(children(buffer, mdia.start, mdia.end, budget), 'hdlr');
  if (hdlr === undefined || hdlr.start + 12 > hdlr.end) {
    return undefined;
  }
  return buffer.toString('latin1', hdlr.start + 8, hdlr.start + 12);
}

/** Lê o `moov` e devolve o que o worker precisa (duração e tamanho da trilha de vídeo). */
export function parseMovieBox(moov: Buffer): Omit<VideoProbe, 'container'> {
  const budget = { left: MAX_CHILD_BOXES };
  const boxes = children(moov, 0, moov.length, budget);
  const mvhd = find(boxes, 'mvhd');
  if (mvhd === undefined) {
    throw invalid('sem mvhd');
  }
  const { timescale, duration: movieDuration } = movieHeader(moov, mvhd);
  if (timescale === 0) {
    throw invalid('escala de tempo zero');
  }
  let duration = movieDuration;
  if (duration === 0) {
    // MP4 fragmentado: a duração total fica no `mvex/mehd`.
    const mvex = find(boxes, 'mvex');
    const mehd =
      mvex === undefined ? undefined : find(children(moov, mvex.start, mvex.end, budget), 'mehd');
    if (mehd !== undefined) {
      const wide = moov.readUInt8(mehd.start) === 1;
      duration = readUint(moov, mehd.start + 4, wide, mehd.end);
    }
  }
  if (duration === 0) {
    throw invalid('duração desconhecida');
  }

  let video: { width: number; height: number } | undefined;
  let fallback: { width: number; height: number } | undefined;
  for (const trak of boxes.filter((box) => box.type === 'trak')) {
    const tkhd = find(children(moov, trak.start, trak.end, budget), 'tkhd');
    if (tkhd === undefined) {
      continue;
    }
    const size = trackSize(moov, tkhd);
    if (size.width <= 0 || size.height <= 0) {
      continue;
    }
    if (handlerOf(moov, trak, budget) === 'vide') {
      video = size;
      break;
    }
    fallback ??= size;
  }
  const dimensions = video ?? fallback;
  if (dimensions === undefined) {
    throw invalid('sem trilha de vídeo');
  }
  return { durationS: duration / timescale, ...dimensions };
}

/**
 * Lê só os cabeçalhos do vídeo de `size` bytes: o `ftyp` (o arquivo começa por ele, como todo MP4 e
 * todo `.mov` do iPhone e do Android), as caixas do primeiro nível até achar o `moov` (no começo ou
 * no fim do arquivo) e o `moov` inteiro. Arquivo que não é vídeo → `PermanentMediaError`.
 */
export async function probeVideo(read: RangeReader, size: number): Promise<VideoProbe> {
  const first = await read(0, Math.min(size, 32));
  const ftyp = readBoxHeader(first, 0, size);
  if (ftyp.type !== 'ftyp' || first.length < ftyp.headerSize + 4) {
    throw invalid('não começa por ftyp');
  }
  const brand = first.toString('latin1', ftyp.headerSize, ftyp.headerSize + 4);
  const container = brand === 'qt  ' ? 'quicktime' : 'mp4';

  let offset = ftyp.size;
  for (let index = 0; index < MAX_TOP_LEVEL_BOXES && offset + 8 <= size; index++) {
    const header = readBoxHeader(await read(offset, 16), 0, size - offset);
    if (header.type === 'moov') {
      const length = header.size - header.headerSize;
      if (length > MAX_MOOV_BYTES) {
        throw invalid('moov grande demais');
      }
      const moov = await read(offset + header.headerSize, length);
      if (moov.length < length) {
        throw invalid('moov truncado');
      }
      try {
        return { container, ...parseMovieBox(moov) };
      } catch (error) {
        // Leitura fora dos limites de uma caixa malformada: o arquivo está corrompido.
        throw error instanceof PermanentMediaError ? error : invalid('cabeçalho corrompido');
      }
    }
    offset += header.size;
  }
  throw invalid('sem moov');
}
