import { MAX_REEL_DURATION_S, MAX_VIDEO_BYTES } from '@sussurro/shared';

import { durationSecondsFromMs, positiveOrNull, videoMimeOf } from './video-file';
import {
  addReelCandidate,
  EMPTY_REEL_SELECTION,
  reelDraftInput,
  reelVideoProblem,
  toggleReelCandidate,
} from '../../features/create/reel-selection';
import { pickedVideo } from '../../test-utils/fake-media';

const POSTER = {
  uri: 'file:///cache/poster.jpg',
  mime: 'image/jpeg' as const,
  sizeBytes: 123_456,
  width: 720,
  height: 1280,
};

describe('vídeo do seletor (5.3, D10)', () => {
  it.each([
    ['video/mp4', 'file:///a.mp4', 'video/mp4'],
    ['video/quicktime', 'file:///a.mov', 'video/quicktime'],
    ['VIDEO/QUICKTIME', 'file:///a', 'video/quicktime'],
    ['video/x-m4v', 'file:///a.m4v', 'video/mp4'],
    ['video/webm', 'file:///a.webm', null],
    ['video/3gpp', 'file:///a.mp4', null],
    [undefined, 'file:///cache/VID_1.MOV', 'video/quicktime'],
    [undefined, 'file:///cache/VID_1.mp4?x=1', 'video/mp4'],
    [undefined, 'file:///cache/VID_1.mkv', null],
    [undefined, 'file:///cache/sem-extensao', null],
  ] as const)('MID-14: tipo %s + %s → %s', (mime, uri, expected) => {
    expect(videoMimeOf(mime, uri)).toBe(expected);
  });

  it('duração em ms → s; tamanho e duração ausentes ou inválidos viram null', () => {
    expect(durationSecondsFromMs(42_517)).toBe(42.517);
    expect(durationSecondsFromMs(null)).toBeNull();
    expect(durationSecondsFromMs(0)).toBeNull();
    expect(positiveOrNull(Number.NaN)).toBeNull();
    expect(positiveOrNull(undefined)).toBeNull();
    expect(positiveOrNull(10)).toBe(10);
  });

  it.each([
    [{ durationS: MAX_REEL_DURATION_S }, null],
    [{ durationS: MAX_REEL_DURATION_S + 1 }, 'too_long'],
    [{ durationS: 90.01 }, 'too_long'],
    [{ sizeBytes: MAX_VIDEO_BYTES }, null],
    [{ sizeBytes: MAX_VIDEO_BYTES + 1 }, 'too_large'],
    [{ mime: null }, 'unsupported'],
    [{ durationS: null }, 'unreadable'],
    [{ sizeBytes: null }, 'unreadable'],
  ] as const)('MID-14: %j → %s (reelVideoLimitViolation + tipo)', (overrides, expected) => {
    expect(reelVideoProblem(pickedVideo(overrides))).toBe(expected);
  });

  it('seleção única: vídeo novo válido fica marcado; recusado não marca', () => {
    const ok = pickedVideo();
    const long = pickedVideo({ durationS: 120 });
    let state = addReelCandidate(EMPTY_REEL_SELECTION, {
      video: ok,
      poster: POSTER,
      problem: null,
    });
    expect(state.selected).toBe(ok.key);
    state = addReelCandidate(state, { video: long, poster: POSTER, problem: 'too_long' });
    expect(state.selected).toBe(ok.key);
    expect(toggleReelCandidate(state, long.key)).toEqual({ state, rejected: 'too_long' });
    expect(toggleReelCandidate(state, ok.key).state.selected).toBeNull();
  });

  it('o rascunho leva tipo, tamanho exato e duração do vídeo e tipo e tamanho da capa', () => {
    const video = pickedVideo({ mime: 'video/mp4', sizeBytes: 9_999, durationS: 12.5 });
    expect(reelDraftInput(video, POSTER)).toEqual({
      video: { mime: 'video/mp4', sizeBytes: 9_999, durationS: 12.5 },
      poster: { mime: 'image/jpeg', sizeBytes: 123_456 },
    });
    expect(() => reelDraftInput(pickedVideo({ mime: null }), POSTER)).toThrow();
  });
});
