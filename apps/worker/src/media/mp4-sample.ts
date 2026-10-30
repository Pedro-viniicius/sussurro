/**
 * MP4/MOV de exemplo, montado caixa a caixa (sem ffmpeg nem download): `ftyp`, `moov` (`mvhd`, uma
 * trilha de vídeo com `tkhd` e `mdia/hdlr`, e opcionalmente `udta` com localização ou `mvex/mehd`)
 * e `mdat` com bytes zerados. Tem a estrutura que o `probeVideo` lê (duração, tamanho e rotação),
 * mas **não toca**: não há amostras de vídeo codificadas. Usado nos testes do worker e no
 * `seed:media` (objeto de exemplo dos reels do seed).
 */
export interface SampleMp4Options {
  /** Duração no `mvhd` (escala de tempo 1000). */
  durationS: number;
  width?: number;
  height?: number;
  /** `qt  ` = `.mov` do iPhone; `isom` = MP4. */
  brand?: 'isom' | 'mp42' | 'qt  ';
  /** `moov` depois do `mdat` (comum em gravações de câmera). */
  moovAtEnd?: boolean;
  /** Matriz do `tkhd` girada 90° (vídeo de celular gravado "deitado" e marcado para girar). */
  rotate90?: boolean;
  /** Bytes do `mdat`. */
  mdatBytes?: number;
  /** `mvhd` com duração 0 e a duração no `mvex/mehd` (MP4 fragmentado). */
  fragmented?: boolean;
  /** `mvhd` e `tkhd` na versão 1 (campos de 64 bits). */
  version1?: boolean;
  /** Localização ISO 6709 no `udta/©xyz`, como o iPhone grava (A-21). */
  location?: string;
  /** Sem trilha de vídeo (só um cabeçalho de filme). */
  withoutVideoTrack?: boolean;
}

function box(type: string, ...payloads: Buffer[]): Buffer {
  const body = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function fullBox(type: string, version: number, flags: number, ...payloads: Buffer[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(version, 0);
  head.writeUIntBE(flags, 1, 3);
  return box(type, head, ...payloads);
}

function uint32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32BE(value >>> 0, index * 4));
  return buffer;
}

function uint64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

const FIXED_ONE = 0x0001_0000;
const IDENTITY = [FIXED_ONE, 0, 0, 0, FIXED_ONE, 0, 0, 0, 0x4000_0000];
const ROTATE_90 = [0, FIXED_ONE, 0, -FIXED_ONE >>> 0, 0, 0, 0, 0, 0x4000_0000];

export function sampleMp4(options: SampleMp4Options): Buffer {
  const timescale = 1000;
  const duration = Math.round(options.durationS * timescale);
  const brand = options.brand ?? 'isom';
  const v1 = options.version1 === true;
  const movieDuration = options.fragmented === true ? 0 : duration;

  const ftyp = box(
    'ftyp',
    Buffer.from(brand, 'latin1'),
    uint32(0),
    Buffer.from(`${brand}mp42`, 'latin1'),
  );
  const times = (value: number) => (v1 ? Buffer.concat([uint64(0), uint64(0)]) : uint32(0, value));
  const mvhd = fullBox(
    'mvhd',
    v1 ? 1 : 0,
    0,
    v1 ? Buffer.concat([uint64(0), uint64(0)]) : uint32(0, 0),
    uint32(timescale),
    v1 ? uint64(movieDuration) : uint32(movieDuration),
    uint32(FIXED_ONE),
    Buffer.from([0x01, 0x00]),
    Buffer.alloc(10),
    uint32(...IDENTITY),
    Buffer.alloc(24),
    uint32(2),
  );
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const tkhd = fullBox(
    'tkhd',
    v1 ? 1 : 0,
    3,
    times(0),
    uint32(1, 0),
    v1 ? uint64(duration) : uint32(duration),
    Buffer.alloc(8),
    Buffer.alloc(8),
    uint32(...(options.rotate90 === true ? ROTATE_90 : IDENTITY)),
    uint32(width * 65536, height * 65536),
  );
  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    uint32(0, 0, timescale, duration),
    Buffer.from([0x55, 0xc4, 0, 0]),
  );
  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    uint32(0),
    Buffer.from('vide', 'latin1'),
    Buffer.alloc(12),
    Buffer.from('VideoHandler\0', 'latin1'),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr));
  const extras: Buffer[] = [];
  if (options.fragmented === true) {
    extras.push(box('mvex', fullBox('mehd', 0, 0, uint32(duration))));
  }
  if (options.location !== undefined) {
    const text = Buffer.from(options.location, 'latin1');
    const header = Buffer.alloc(4);
    header.writeUInt16BE(text.length, 0);
    header.writeUInt16BE(0x15c7, 2);
    extras.push(box('udta', box('©xyz', header, text)));
  }
  const moov = box('moov', mvhd, ...(options.withoutVideoTrack === true ? [] : [trak]), ...extras);
  const mdat = box('mdat', Buffer.alloc(options.mdatBytes ?? 256));
  return options.moovAtEnd === true
    ? Buffer.concat([ftyp, mdat, moov])
    : Buffer.concat([ftyp, moov, mdat]);
}
