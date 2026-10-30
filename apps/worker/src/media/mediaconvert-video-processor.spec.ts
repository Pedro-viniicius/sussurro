// Job e eventos do MediaConvert (história 5.2, ADR 0006) com um dublê do cliente da AWS: nenhuma
// chamada sai da máquina. A remoção da localização no vídeo de verdade só é verificável na AWS
// (A-21): roteiro do MID-14 em docs/equipe/testes.md §8.2.
import { CreateJobCommand } from '@aws-sdk/client-mediaconvert';
import { describe, expect, it } from 'vitest';

import {
  buildCreateJobInput,
  type MediaConvertSender,
  MediaConvertVideoProcessor,
  parseMediaConvertEvent,
} from './mediaconvert-video-processor.js';
import { sampleMp4 } from './mp4-sample.js';
import { InMemoryObjectStorage } from '../testing/in-memory-storage.js';

const MEDIA_ID = '01a189e0-af57-7000-85fe-2054e618fea6';
const BUCKET = 'sussurro-prod-media';
const SETTINGS = {
  bucket: BUCKET,
  roleArn: 'arn:aws:iam::123456789012:role/sussurro-mediaconvert',
  queueArn: undefined,
};

function event(detail: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    version: '0',
    id: 'e1',
    'detail-type': 'MediaConvert Job State Change',
    source: 'aws.mediaconvert',
    account: '123456789012',
    region: 'sa-east-1',
    resources: ['arn:aws:mediaconvert:sa-east-1:123456789012:jobs/1700000000000-abc123'],
    detail: {
      timestamp: 1_700_000_000_000,
      accountId: '123456789012',
      queue: 'arn:aws:mediaconvert:sa-east-1:123456789012:queues/Default',
      jobId: '1700000000000-abc123',
      userMetadata: { app: 'sussurro', mediaId: MEDIA_ID },
      ...detail,
    },
    ...overrides,
  };
}

function complete(outputs: { path: string; durationInMs?: number; w?: number; h?: number }[]) {
  return event({
    status: 'COMPLETE',
    outputGroupDetails: outputs.map((output) => ({
      type: 'FILE_GROUP',
      outputDetails: [
        {
          outputFilePaths: [output.path],
          ...(output.durationInMs === undefined ? {} : { durationInMs: output.durationInMs }),
          videoDetails: { widthInPx: output.w ?? 720, heightInPx: output.h ?? 1280 },
        },
      ],
    })),
  });
}

const VIDEO_PATH = `s3://${BUCKET}/media/${MEDIA_ID}/video.mp4`;
const POSTER_PATH = `s3://${BUCKET}/media/${MEDIA_ID}/poster.0000000.jpg`;

describe('buildCreateJobInput (5.2)', () => {
  const input = buildCreateJobInput(
    { mediaId: MEDIA_ID, sourceKey: `incoming/u1/${MEDIA_ID}` },
    SETTINGS,
  );
  const [mp4Group, posterGroup] = input.Settings?.OutputGroups ?? [];
  const mp4 = mp4Group?.Outputs?.[0];
  const poster = posterGroup?.Outputs?.[0];

  it('identifica o job: userMetadata.app = sussurro, mediaId e ClientRequestToken', () => {
    expect(input.UserMetadata).toEqual({ app: 'sussurro', mediaId: MEDIA_ID });
    expect(input.ClientRequestToken).toBe(MEDIA_ID);
    expect(input.Role).toBe(SETTINGS.roleArn);
    expect(input).not.toHaveProperty('Queue');
  });

  it('lê o original em incoming/ com a rotação aplicada e o timecode zerado', () => {
    expect(input.Settings?.Inputs).toEqual([
      expect.objectContaining({
        FileInput: `s3://${BUCKET}/incoming/u1/${MEDIA_ID}`,
        TimecodeSource: 'ZEROBASED',
        VideoSelector: { Rotate: 'AUTO' },
      }),
    ]);
  });

  it('[MID-14] MP4 H.264/AAC 720×1280 progressivo em media/{id}/video.mp4, sem C2PA', () => {
    expect(mp4Group?.OutputGroupSettings).toEqual({
      Type: 'FILE_GROUP_SETTINGS',
      FileGroupSettings: { Destination: `s3://${BUCKET}/media/${MEDIA_ID}/video` },
    });
    expect(mp4).toMatchObject({
      Extension: 'mp4',
      ContainerSettings: {
        Container: 'MP4',
        Mp4Settings: { MoovPlacement: 'PROGRESSIVE_DOWNLOAD', C2paManifest: 'EXCLUDE' },
      },
      VideoDescription: {
        Width: 720,
        Height: 1280,
        ScalingBehavior: 'FIT',
        CodecSettings: { Codec: 'H_264', H264Settings: { RateControlMode: 'QVBR' } },
      },
      AudioDescriptions: [{ CodecSettings: { Codec: 'AAC' } }],
    });
  });

  it('[MID-14] um quadro JPEG como poster em media/{id}/poster…', () => {
    expect(posterGroup?.OutputGroupSettings?.FileGroupSettings?.Destination).toBe(
      `s3://${BUCKET}/media/${MEDIA_ID}/poster`,
    );
    expect(poster?.VideoDescription?.CodecSettings).toEqual({
      Codec: 'FRAME_CAPTURE',
      FrameCaptureSettings: {
        FramerateNumerator: 1,
        FramerateDenominator: 1,
        MaxCaptures: 1,
        Quality: 80,
      },
    });
  });

  it('nenhuma saída grava fora de media/{id}/ nem pede metadados temporizados', () => {
    const destinations = (input.Settings?.OutputGroups ?? []).map(
      (group) => group.OutputGroupSettings?.FileGroupSettings?.Destination ?? '',
    );
    expect(destinations.every((dest) => dest.startsWith(`s3://${BUCKET}/media/${MEDIA_ID}/`))).toBe(
      true,
    );
    expect(input.Settings).not.toHaveProperty('TimedMetadataInsertion');
  });

  it('usa a fila do MediaConvert quando configurada', () => {
    const queueArn = 'arn:aws:mediaconvert:sa-east-1:123456789012:queues/reels';
    expect(
      buildCreateJobInput(
        { mediaId: MEDIA_ID, sourceKey: 'incoming/u/x' },
        { ...SETTINGS, queueArn },
      ).Queue,
    ).toBe(queueArn);
  });
});

describe('parseMediaConvertEvent (5.2 CA2 e CA3)', () => {
  it('[5.2 CA2] COMPLETE → ready com as chaves, a duração e o tamanho medidos', () => {
    expect(
      parseMediaConvertEvent(
        complete([{ path: VIDEO_PATH, durationInMs: 42_040 }, { path: POSTER_PATH }]),
        BUCKET,
      ),
    ).toEqual({
      mediaId: MEDIA_ID,
      jobId: '1700000000000-abc123',
      status: 'ready',
      outputKey: `media/${MEDIA_ID}/video.mp4`,
      posterKey: `media/${MEDIA_ID}/poster.0000000.jpg`,
      durationS: 42.04,
      width: 720,
      height: 1280,
      outputKeys: [`media/${MEDIA_ID}/video.mp4`, `media/${MEDIA_ID}/poster.0000000.jpg`],
    });
  });

  it('[5.2 CA2] ERROR → failed com o código e a mensagem', () => {
    expect(
      parseMediaConvertEvent(
        event({ status: 'ERROR', errorCode: 1030, errorMessage: 'Unsupported codec' }),
        BUCKET,
      ),
    ).toEqual({
      mediaId: MEDIA_ID,
      jobId: '1700000000000-abc123',
      status: 'failed',
      error: 'MediaConvert 1030: Unsupported codec',
    });
  });

  it('[5.2 CA3] outro app, sem app, sem mediaId válido, outro serviço ou estado intermediário → descartado', () => {
    const others = [
      event({ status: 'COMPLETE', userMetadata: { app: 'outro-app', mediaId: MEDIA_ID } }),
      event({ status: 'COMPLETE', userMetadata: {} }),
      event({ status: 'COMPLETE', userMetadata: { app: 'sussurro', mediaId: 'nao-e-uuid' } }),
      event({ status: 'COMPLETE' }, { source: 'aws.s3' }),
      event({ status: 'COMPLETE' }, { 'detail-type': 'MediaConvert Job Queue Change' }),
      event({ status: 'PROGRESSING' }),
      event({ status: 'INPUT_INFORMATION' }),
      'texto',
      null,
      {},
    ];
    for (const item of others) {
      expect(parseMediaConvertEvent(item, BUCKET)).toBeNull();
    }
  });

  it('saída fora de media/{id}/, de outro bucket ou faltando → failed (com as saídas para apagar)', () => {
    const foreign = parseMediaConvertEvent(
      complete([
        { path: `s3://${BUCKET}/media/outro-id/video.mp4`, durationInMs: 1000 },
        { path: POSTER_PATH },
      ]),
      BUCKET,
    );
    expect(foreign).toMatchObject({
      status: 'failed',
      outputKeys: [`media/${MEDIA_ID}/poster.0000000.jpg`],
    });
    expect(
      parseMediaConvertEvent(
        complete([{ path: `s3://outro-bucket/media/${MEDIA_ID}/video.mp4` }]),
        BUCKET,
      ),
    ).toMatchObject({ status: 'failed' });
    expect(
      parseMediaConvertEvent(complete([{ path: VIDEO_PATH, durationInMs: 1000 }]), BUCKET),
    ).toMatchObject({ status: 'failed', outputKeys: [`media/${MEDIA_ID}/video.mp4`] });
  });
});

describe('MediaConvertVideoProcessor.submit', () => {
  function processor(storage: InMemoryObjectStorage, sent: CreateJobCommand[]) {
    const client: MediaConvertSender = {
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ Job: { Id: 'job-123' }, $metadata: {} } as never);
      },
    };
    return new MediaConvertVideoProcessor(client, storage, SETTINGS);
  }

  it('[5.2] cria o job e devolve o id; o fim chega pela video-events (sem completion)', async () => {
    const storage = new InMemoryObjectStorage();
    storage.objects.set('incoming/u/v', { body: sampleMp4({ durationS: 30 }), contentType: 'x' });
    const sent: CreateJobCommand[] = [];
    await expect(
      processor(storage, sent).submit({
        mediaId: MEDIA_ID,
        sourceKey: 'incoming/u/v',
        posterSourceKey: 'incoming/u/v-poster',
        posterMime: 'image/jpeg',
      }),
    ).resolves.toEqual({ jobId: 'job-123', completion: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(CreateJobCommand);
    expect(sent[0]?.input.UserMetadata).toEqual({ app: 'sussurro', mediaId: MEDIA_ID });
  });

  it('[MID-14] vídeo acima de 90 s ou arquivo que não é vídeo: recusa antes de pagar o job', async () => {
    const storage = new InMemoryObjectStorage();
    storage.objects.set('long', { body: sampleMp4({ durationS: 91 }), contentType: 'x' });
    storage.objects.set('html', { body: Buffer.from('<html></html>'), contentType: 'x' });
    const sent: CreateJobCommand[] = [];
    const source = { mediaId: MEDIA_ID, posterSourceKey: 'p', posterMime: 'image/jpeg' };
    await expect(processor(storage, sent).submit({ ...source, sourceKey: 'long' })).rejects.toThrow(
      /o limite é 90 s/,
    );
    await expect(processor(storage, sent).submit({ ...source, sourceKey: 'html' })).rejects.toThrow(
      /não é um vídeo/,
    );
    expect(sent).toHaveLength(0);
  });
});
