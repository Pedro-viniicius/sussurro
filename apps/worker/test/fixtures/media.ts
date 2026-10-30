// Fixtures de mídia (testes.md §2.2) geradas na hora com o sharp e o zlib do Node: nada é baixado
// nem fica versionado. Cada imagem leva EXIF (aparelho), GPS, XMP e IPTC com valores marcados,
// para o teste procurar esses bytes na saída (MID-05).
import { crc32, deflateSync } from 'node:zlib';

import sharp from 'sharp';

/** Valores marcados que não podem aparecer em nenhuma saída. */
export const MARKERS = {
  make: 'MarcaSecreta',
  model: 'ModeloSecreto',
  city: 'CidadeSecreta',
  xmp: 'XmpSecreto',
} as const;

const EXIF = {
  IFD0: { Make: MARKERS.make, Model: MARKERS.model, Software: 'Sussurro-teste' },
  // IFD3 = GPS: Curitiba (25°25'S, 49°16'W).
  IFD3: {
    GPSLatitudeRef: 'S',
    GPSLatitude: '25/1 25/1 0/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '49/1 16/1 0/1',
  },
};

const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  `<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="25,25.0S" exif:UserComment="${MARKERS.xmp}"/>` +
  '</rdf:RDF></x:xmpmeta>';

/** Segmento APP13 (Photoshop IRB) com um registro IPTC 2:90 (cidade). O sharp não grava IPTC. */
function iptcSegment(city: string): Buffer {
  const value = Buffer.from(city, 'utf8');
  const dataset = Buffer.concat([Buffer.from([0x1c, 0x02, 0x5a, 0x00, value.length]), value]);
  const resource = Buffer.concat([
    Buffer.from('8BIM'),
    Buffer.from([0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, dataset.length]),
    dataset,
    dataset.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);
  const payload = Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), resource]);
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, 0xed, length >> 8, length & 0xff]), payload]);
}

/** Imagem de 1600×1200 com degradê (não é cor sólida: o JPEG tem conteúdo de verdade). */
function canvas(width = 1600, height = 1200) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

/** `jpeg-gps.jpg`: EXIF + GPS + XMP + IPTC. */
export async function jpegWithEverything(): Promise<Buffer> {
  const jpeg = await canvas().jpeg({ quality: 90 }).withExif(EXIF).withXmp(XMP).toBuffer();
  // IPTC logo depois do SOI (FF D8).
  return Buffer.concat([jpeg.subarray(0, 2), iptcSegment(MARKERS.city), jpeg.subarray(2)]);
}

/** `png-exif.png`: EXIF (eXIf) + GPS + XMP (iTXt). */
export function pngWithMetadata(): Promise<Buffer> {
  return canvas().png().withExif(EXIF).withXmp(XMP).toBuffer();
}

/** `webp-exif.webp`: EXIF + GPS + XMP. */
export function webpWithMetadata(): Promise<Buffer> {
  return canvas().webp({ quality: 90 }).withExif(EXIF).withXmp(XMP).toBuffer();
}

/**
 * `rotated-90.jpg`: gravada deitada (400×200, metade esquerda vermelha e direita azul) com
 * orientação EXIF 6 (girar 90° no sentido horário). Na orientação certa fica em pé (200×400),
 * vermelha em cima e azul embaixo.
 */
export async function rotated90Jpeg(): Promise<Buffer> {
  const red = await sharp({
    create: { width: 200, height: 200, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withExif(EXIF)
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/** `html-as.jpg`: HTML declarado como JPEG (MID-04). */
export const HTML_AS_JPEG = Buffer.from(
  '<!doctype html><html><body><script>alert(1)</script></body></html>',
);

/** SVG declarado como JPEG (MID-04): o sharp decodificaria SVG se chegasse até ele. */
export const SVG_AS_JPEG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"><rect width="4000" height="4000" fill="red"/></svg>',
);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * `bomb-30000px.png` (MID-06): PNG válido de 30000×30000 px (900 milhões de pixels), 1 bit por
 * pixel, todo preto, comprimido com o zlib (cerca de 110 KB no disco, 2,7 GB se decodificado em
 * RGB). Montado à mão porque gerar pelo sharp exigiria decodificar a imagem inteira.
 */
export function pngBomb(width = 30_000, height = 30_000): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // tons de cinza
  const rowBytes = 1 + Math.ceil(width / 8); // filtro + pixels
  const raw = Buffer.alloc(rowBytes * height); // zeros: filtro 0 e pixels pretos
  const compressed = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Procura, nos bytes de uma saída, rastros dos metadados: os cabeçalhos de EXIF, XMP e IPTC e os
 * valores marcados (agulhas de 6+ bytes: sequências curtas apareceriam por acaso nos dados
 * comprimidos). Devolve o que achou (vazio = limpo).
 */
export function metadataTraces(output: Buffer): string[] {
  const needles: [string, Buffer][] = [
    ['APP1 Exif', Buffer.from('Exif\0\0', 'latin1')],
    ['XMP', Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1')],
    ['xmpmeta', Buffer.from('xmpmeta', 'latin1')],
    ['IPTC/Photoshop', Buffer.from('Photoshop 3.0', 'latin1')],
    ...Object.entries(MARKERS).map(
      ([name, value]) => [name, Buffer.from(value, 'utf8')] as [string, Buffer],
    ),
  ];
  return needles.filter(([, needle]) => output.includes(needle)).map(([name]) => name);
}

/**
 * Marcadores dos segmentos de um JPEG até o início dos dados (SOS). Uma saída limpa não tem APP1
 * (EXIF/XMP, `E1`), APP2 (ICC, `E2`) nem APP13 (IPTC, `ED`): a tag GPS só existe dentro do APP1.
 */
export function jpegSegments(jpeg: Buffer): string[] {
  const markers: string[] = [];
  let offset = 2; // depois do SOI
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1] ?? 0;
    markers.push(marker.toString(16).toUpperCase());
    if (marker === 0xda) {
      break; // SOS: dali em diante, dados da imagem
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return markers;
}
