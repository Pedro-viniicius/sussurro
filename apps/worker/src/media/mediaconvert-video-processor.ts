import {
  CreateJobCommand,
  type CreateJobCommandInput,
  type CreateJobCommandOutput,
} from '@aws-sdk/client-mediaconvert';
import { z } from 'zod';

import {
  inspectStoredVideo,
  VIDEO_APP_TAG,
  type VideoCompletion,
  VideoProcessor,
  type VideoSource,
  type VideoSubmission,
} from './video-processor.js';
import type { ObjectStorage } from '../infra/storage.js';

/** Tamanho da saída (ADR 0006): MP4 H.264/AAC progressivo, vertical, 720×1280. */
export const REEL_OUTPUT_WIDTH = 720;
export const REEL_OUTPUT_HEIGHT = 1280;
const AUDIO_SELECTOR = 'Audio Selector 1';

/** O que o processador precisa do cliente do MediaConvert (o teste usa um dublê, sem rede). */
export interface MediaConvertSender {
  send(command: CreateJobCommand): Promise<CreateJobCommandOutput>;
}

export interface MediaConvertSettings {
  bucket: string;
  /** Role de serviço do MediaConvert: lê `incoming/*` e grava `media/*` (infra.md §6.5). */
  roleArn: string;
  /** Fila do MediaConvert; vazio = a fila `Default` da conta. */
  queueArn: string | undefined;
}

/**
 * Job do MediaConvert de um reel (ADR 0006, história 5.2):
 * - entrada: o original em `incoming/`, com a rotação do container aplicada nos pixels
 *   (`Rotate: AUTO`) e o timecode zerado;
 * - saída 1: MP4 H.264 (QVBR, uma passada) + AAC, 720×1280 sem distorcer (`FIT`), com o `moov` no
 *   começo (toca enquanto baixa) em `media/{id}/video.mp4`;
 * - saída 2: um quadro JPEG (poster da grade e do visualizador) em `media/{id}/poster.0000000.jpg`.
 *
 * **Localização** (5.2 CA1, A-21): o MediaConvert gera um container novo e não copia os metadados
 * do original (`udta`/`©xyz` do iPhone, XMP); o manifesto C2PA, que pode levar asserções de
 * local, fica excluído de forma explícita. Só verificável na AWS: roteiro do MID-14 em
 * `docs/equipe/testes.md` §8.2.
 *
 * `userMetadata.app` identifica os jobs deste app (a regra do EventBridge e o consumidor filtram) e
 * `userMetadata.mediaId` liga o evento à mídia. `ClientRequestToken` = id da mídia: uma mensagem
 * repetida em até 1 min devolve o mesmo job em vez de criar outro.
 */
export function buildCreateJobInput(
  source: Pick<VideoSource, 'mediaId' | 'sourceKey'>,
  settings: MediaConvertSettings,
): CreateJobCommandInput {
  const destination = `s3://${settings.bucket}/media/${source.mediaId}/`;
  return {
    Role: settings.roleArn,
    ...(settings.queueArn === undefined ? {} : { Queue: settings.queueArn }),
    ClientRequestToken: source.mediaId,
    UserMetadata: { app: VIDEO_APP_TAG, mediaId: source.mediaId },
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [
        {
          FileInput: `s3://${settings.bucket}/${source.sourceKey}`,
          TimecodeSource: 'ZEROBASED',
          VideoSelector: { Rotate: 'AUTO' },
          AudioSelectors: { [AUDIO_SELECTOR]: { DefaultSelection: 'DEFAULT' } },
        },
      ],
      OutputGroups: [
        {
          Name: 'Reel MP4',
          OutputGroupSettings: {
            Type: 'FILE_GROUP_SETTINGS',
            FileGroupSettings: { Destination: `${destination}video` },
          },
          Outputs: [
            {
              Extension: 'mp4',
              ContainerSettings: {
                Container: 'MP4',
                Mp4Settings: {
                  MoovPlacement: 'PROGRESSIVE_DOWNLOAD',
                  C2paManifest: 'EXCLUDE',
                  FreeSpaceBox: 'EXCLUDE',
                },
              },
              VideoDescription: {
                Width: REEL_OUTPUT_WIDTH,
                Height: REEL_OUTPUT_HEIGHT,
                ScalingBehavior: 'FIT',
                TimecodeInsertion: 'DISABLED',
                CodecSettings: {
                  Codec: 'H_264',
                  H264Settings: {
                    RateControlMode: 'QVBR',
                    QvbrSettings: { QvbrQualityLevel: 7 },
                    MaxBitrate: 3_500_000,
                    QualityTuningLevel: 'SINGLE_PASS',
                    SceneChangeDetect: 'TRANSITION_DETECTION',
                    CodecProfile: 'MAIN',
                  },
                },
              },
              AudioDescriptions: [
                {
                  AudioSourceName: AUDIO_SELECTOR,
                  CodecSettings: {
                    Codec: 'AAC',
                    AacSettings: {
                      Bitrate: 96_000,
                      CodingMode: 'CODING_MODE_2_0',
                      SampleRate: 48_000,
                    },
                  },
                },
              ],
            },
          ],
        },
        {
          Name: 'Poster',
          OutputGroupSettings: {
            Type: 'FILE_GROUP_SETTINGS',
            FileGroupSettings: { Destination: `${destination}poster` },
          },
          Outputs: [
            {
              Extension: 'jpg',
              ContainerSettings: { Container: 'RAW' },
              VideoDescription: {
                Width: REEL_OUTPUT_WIDTH,
                Height: REEL_OUTPUT_HEIGHT,
                ScalingBehavior: 'FIT',
                CodecSettings: {
                  Codec: 'FRAME_CAPTURE',
                  FrameCaptureSettings: {
                    FramerateNumerator: 1,
                    FramerateDenominator: 1,
                    MaxCaptures: 1,
                    Quality: 80,
                  },
                },
              },
            },
          ],
        },
      ],
    },
  };
}

/** Evento "MediaConvert Job State Change" do EventBridge (o corpo da mensagem na `video-events`). */
const MediaConvertEventSchema = z.object({
  source: z.literal('aws.mediaconvert'),
  'detail-type': z.literal('MediaConvert Job State Change'),
  detail: z.object({
    jobId: z.string().min(1),
    status: z.string(),
    userMetadata: z.record(z.string(), z.string()).optional(),
    errorCode: z.union([z.number(), z.string()]).optional(),
    errorMessage: z.string().optional(),
    outputGroupDetails: z
      .array(
        z.object({
          outputDetails: z
            .array(
              z.object({
                outputFilePaths: z.array(z.string()).optional(),
                durationInMs: z.number().optional(),
                videoDetails: z
                  .object({ widthInPx: z.number().optional(), heightInPx: z.number().optional() })
                  .optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  }),
});

/** `s3://bucket/media/{id}/…` → `media/{id}/…`; outro bucket ou outro prefixo → `null`. */
function outputKey(path: string, bucket: string, mediaId: string): string | null {
  const prefix = `s3://${bucket}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const key = path.slice(prefix.length);
  return key.startsWith(`media/${mediaId}/`) && !key.includes('..') ? key : null;
}

/**
 * Lê o evento do EventBridge (5.2 CA2 e CA3). Descarta (`null`) o que não é um job deste app:
 * outro serviço, outro `userMetadata.app`, sem `mediaId` ou estado intermediário. `COMPLETE`
 * vira `ready` com as chaves do MP4 e do poster e a duração e o tamanho medidos; saídas fora de
 * `media/{id}/` ou faltando viram `failed`. `ERROR` vira `failed` com o código e a mensagem.
 */
export function parseMediaConvertEvent(event: unknown, bucket: string): VideoCompletion | null {
  const parsed = MediaConvertEventSchema.safeParse(event);
  if (!parsed.success) {
    return null;
  }
  const { detail } = parsed.data;
  const mediaId = detail.userMetadata?.mediaId;
  if (
    detail.userMetadata?.app !== VIDEO_APP_TAG ||
    mediaId === undefined ||
    !z.uuid().safeParse(mediaId).success
  ) {
    return null;
  }
  const base = { mediaId, jobId: detail.jobId };
  if (detail.status === 'ERROR') {
    const code = detail.errorCode === undefined ? '' : ` ${String(detail.errorCode)}`;
    return {
      ...base,
      status: 'failed',
      error: `MediaConvert${code}: ${detail.errorMessage ?? 'erro sem mensagem'}`,
    };
  }
  if (detail.status !== 'COMPLETE') {
    return null;
  }

  const outputs = (detail.outputGroupDetails ?? []).flatMap((group) => group.outputDetails ?? []);
  const keys: string[] = [];
  let video: { key: string; durationMs?: number; width?: number; height?: number } | undefined;
  let poster: string | undefined;
  let foreign = false;
  for (const output of outputs) {
    for (const path of output.outputFilePaths ?? []) {
      const key = outputKey(path, bucket, base.mediaId);
      if (key === null) {
        foreign = true;
        continue;
      }
      keys.push(key);
      if (key.endsWith('.mp4')) {
        video = {
          key,
          ...(output.durationInMs === undefined ? {} : { durationMs: output.durationInMs }),
          ...(output.videoDetails?.widthInPx === undefined
            ? {}
            : { width: output.videoDetails.widthInPx }),
          ...(output.videoDetails?.heightInPx === undefined
            ? {}
            : { height: output.videoDetails.heightInPx }),
        };
      } else if (key.endsWith('.jpg')) {
        poster ??= key;
      }
    }
  }
  if (foreign || video === undefined || poster === undefined) {
    return {
      ...base,
      status: 'failed',
      error: 'Saída do MediaConvert incompleta ou fora de media/{id}/',
      outputKeys: keys,
    };
  }
  return {
    ...base,
    status: 'ready',
    outputKey: video.key,
    posterKey: poster,
    ...(video.durationMs === undefined ? {} : { durationS: video.durationMs / 1000 }),
    width: video.width ?? REEL_OUTPUT_WIDTH,
    height: video.height ?? REEL_OUTPUT_HEIGHT,
    outputKeys: keys,
  };
}

/**
 * `VIDEO_PROCESSOR=mediaconvert` (ADR 0006, história 5.2): confere o vídeo em `incoming/` (magic
 * bytes e até 90 s, para não pagar a conversão de um arquivo inválido) e cria o job. O fim chega
 * depois, pela fila `video-events` (EventBridge → SQS).
 */
export class MediaConvertVideoProcessor extends VideoProcessor {
  readonly name = 'mediaconvert' as const;
  readonly usesUploadedPoster = false;

  constructor(
    private readonly client: MediaConvertSender,
    private readonly storage: ObjectStorage,
    private readonly settings: MediaConvertSettings,
  ) {
    super();
  }

  async submit(source: VideoSource): Promise<VideoSubmission> {
    await inspectStoredVideo(this.storage, source.sourceKey);
    const output = await this.client.send(
      new CreateJobCommand(buildCreateJobInput(source, this.settings)),
    );
    const jobId = output.Job?.Id;
    if (jobId === undefined || jobId === '') {
      throw new Error('O MediaConvert não devolveu o id do job');
    }
    return { jobId, completion: null };
  }

  parseCompletion(event: unknown): VideoCompletion | null {
    return parseMediaConvertEvent(event, this.settings.bucket);
  }
}
