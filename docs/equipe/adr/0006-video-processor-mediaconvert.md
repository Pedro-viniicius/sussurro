# ADR 0006: VideoProcessor com AWS MediaConvert na v1

- Status: ~~proposto~~ Aceita (PO, 2026-10-29) · Data: 2026-10-29
- (revisto em 2026-10-31) Status atualizado: o PO aprovou o plano em 2026-10-29, e as recomendações da §8 do `PROJETO.md` passaram a valer como decididas (`PROJETO.md`, topo).

## Contexto
Os reels são vídeos verticais curtos, sem autoplay do próximo. A especificação pede serviço gerenciado (MediaConvert ou Mux) atrás de `VideoProcessor`, sem pipeline HLS próprio.

## Decisão
Interface em `apps/worker`:

```ts
interface VideoProcessor {
  submit(input: { mediaId: string; sourceKey: string }): Promise<{ jobId: string }>;
  parseCompletion(event: unknown): { mediaId: string; status: 'ready' | 'failed';
    outputKey?: string; posterKey?: string; durationS?: number; width?: number; height?: number; error?: string };
}
```

- **v1: `MediaConvertVideoProcessor`**. Saída **MP4 H.264/AAC progressivo, 720×1280** (QVBR, uma passada), mais um frame JPEG como poster/thumb da grade. Para reels de até 90 s, MP4 progressivo com `expo-video` é suficiente e evita a complexidade de HLS. O fim do job chega por EventBridge → SQS `video-events` → worker. Os metadados de localização do container original não são copiados (validar no teste com um vídeo de iPhone com GPS). O original em `incoming/` é apagado.
- **Dev/CI: `PassthroughVideoProcessor`**: copia o original para `media/{id}/video.mp4`, usa o poster gerado no app (`expo-video-thumbnails`, enviado junto) e marca `ready`. O MediaConvert não tem emulação gratuita.
- A troca é feita por env (`VIDEO_PROCESSOR=mediaconvert|passthrough|mux`).

## Alternativas
- **Mux**: melhor DX (HLS adaptativo, thumbnails, player analytics, encoding grátis no plano básico), cobrando armazenamento e entrega por minuto. Tem pontos contra na v1: segundo fornecedor e segunda fatura, dados de usuários processados e entregues fora da AWS e da região (avaliar transferência internacional na LGPD), webhook público a proteger e mídia de conta pessoal servida por outro CDN (as URLs assinadas exigiriam a configuração de signed playback do Mux). Fica como alternativa se precisarmos de HLS adaptativo rapidamente.
- **FFmpeg próprio no worker**: proibido pela especificação na v1 e caro de operar.

## Consequências
- Custo: MediaConvert cobra por minuto de saída (tier Basic AVC, cerca de US$ 0,0075/min em us-east-1; **confirmar o preço e a disponibilidade em sa-east-1 na página oficial**). Com 1 saída de vídeo e 1 frame, mil reels de 30 s custam por volta de US$ 4 a 6 de transcodificação. A entrega sai pelo CloudFront, já previsto. Configurar budget alarm.
- Sem bitrate adaptativo na v1: em redes ruins o vídeo de 720p demora mais a começar. Aceitável para vídeo curto.
- O Terraform cria a role do MediaConvert, a regra do EventBridge e a fila `video-events` com DLQ.
