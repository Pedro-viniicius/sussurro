import { useState } from 'react';
import { View, type ViewProps } from 'react-native';

type Listener = (payload?: unknown) => void;

/**
 * Player falso do `expo-video` (o mock do próprio pacote nunca termina o vídeo nem muda o status):
 * guarda as chamadas e deixa o teste emitir os eventos (`statusChange`, `timeUpdate`,
 * `playToEnd`).
 */
export class FakeVideoPlayer {
  playing = false;
  muted = false;
  loop = true;
  currentTime = 0;
  duration = 30;
  status: 'idle' | 'loading' | 'readyToPlay' | 'error' = 'loading';
  timeUpdateEventInterval = 0;
  staysActiveInBackground = true;
  showNowPlayingNotification = true;
  allowsExternalPlayback = true;
  /** Chamadas na ordem: `play`, `pause`, `replay`, `replace`. */
  readonly calls: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly source: unknown) {}

  addListener(name: string, listener: Listener) {
    const set = this.listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(name, set);
    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  emit(name: string, payload?: unknown) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(payload);
  }

  play() {
    this.calls.push('play');
    if (!this.playing) {
      this.playing = true;
      this.emit('playingChange', { isPlaying: true });
    }
  }

  pause() {
    this.calls.push('pause');
    if (this.playing) {
      this.playing = false;
      this.emit('playingChange', { isPlaying: false });
    }
  }

  replay() {
    this.calls.push('replay');
    this.currentTime = 0;
  }

  replace() {
    this.calls.push('replace');
  }

  replaceAsync() {
    this.calls.push('replace');
    return Promise.resolve();
  }

  /** Simula o avanço do vídeo (o evento que move a barra de progresso). */
  timeUpdate(currentTime: number) {
    this.currentTime = currentTime;
    this.emit('timeUpdate', { currentTime, bufferedPosition: currentTime });
  }

  /** Simula o fim do vídeo: o player nativo para sozinho e avisa. */
  finish() {
    this.currentTime = this.duration;
    this.playing = false;
    this.emit('playingChange', { isPlaying: false });
    this.emit('playToEnd');
  }

  setStatus(status: FakeVideoPlayer['status']) {
    this.status = status;
    this.emit('statusChange', { status });
  }
}

/** Players criados desde o último `reset` (o mais novo no fim). */
export const fakeVideo = {
  players: [] as FakeVideoPlayer[],
  reset() {
    this.players.length = 0;
  },
  last(): FakeVideoPlayer {
    const player = this.players.at(-1);
    if (player === undefined) throw new Error('nenhum player criado');
    return player;
  },
};

/** O que `jest.mock('expo-video', ...)` devolve. */
export const expoVideoMock = {
  useVideoPlayer(source: unknown, setup?: (player: FakeVideoPlayer) => void) {
    const [player] = useState(() => {
      const created = new FakeVideoPlayer(source);
      setup?.(created);
      fakeVideo.players.push(created);
      return created;
    });
    return player;
  },
  VideoView({ player: _player, testID, ...props }: ViewProps & { player?: unknown }) {
    return <View testID={testID ?? 'video-view'} {...props} />;
  },
};
