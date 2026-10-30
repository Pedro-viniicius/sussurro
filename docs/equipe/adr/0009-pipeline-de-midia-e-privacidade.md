# ADR 0009: Pipeline de mídia (upload direto, processamento, URLs assinadas)

- Status: proposto · Data: 2026-10-29

## Contexto
O upload vai direto ao S3 por URL pré-assinada. Fotos de celular carregam EXIF com GPS, e o produto promete que "ninguém vê sua localização". A mídia de contas pessoais só deve ser vista por conexões.

## Decisão
- **Rascunho → upload → publicação**: `POST /posts/drafts` cria o post `draft` e `post_media(pending_upload)` e devolve **URLs PUT pré-assinadas** (10 min) com `Content-Type` e `Content-Length` assinados. O app envia e chama `POST /posts/:id/publish`. A API faz `HEAD` de cada objeto, valida e enfileira em `media-jobs`.
- Usamos PUT em vez de POST policy porque funciona igual na AWS e nos emuladores (ADR 0010) e o tamanho fica travado pela assinatura.
- **Cliente**: converte HEIC para JPEG e reduz para <= 2160 px (`expo-image-manipulator`, que também descarta o EXIF). Mesmo assim, **o servidor não confia no cliente**.
- **Worker (imagem)**: confere magic bytes (`file-type`), `sharp().rotate()`, **remove todos os metadados**, gera `full` (1080 w) e `thumb` (360 w) em JPEG, grava em `media/{mediaId}/`, apaga `incoming/` e marca `ready`. Quando o post tem todas as mídias prontas, ele vira `published`.
- **Vídeo**: ADR 0006.
- **Leitura**: bucket privado com OAC, servido pelo CloudFront com **URLs assinadas** de 6 h geradas pela API depois do `AccessPolicyService`. No app, a chave de cache do `expo-image` é o `mediaId`, para não baixar de novo quando a URL muda.
- **Limpeza**: lifecycle de 1 dia em `incoming/`, job que apaga rascunhos com mais de 24 h, e remoção de objetos na exclusão de post ou conta.
- **Status**: `post_media.status` com `pending_upload → processing → ready|failed`. Mensagens SQS com DLQ (3 tentativas).

## Alternativas
- **Upload pela API (multipart)**: banda e memória na API. Descartado pela especificação.
- **Gatilho por evento S3 → SQS em vez de `publish`**: dispensa uma chamada, mas exige configuração de notificação de bucket também nos emuladores e não junta a legenda. `publish` é explícito e testável.
- **CloudFront público com chaves impossíveis de adivinhar**: mais simples, mas um link vazado expõe para sempre a mídia de conta pessoal. As URLs assinadas custam pouco (uma chave e um assinador).
- **Processamento síncrono na API**: bloqueia requisições. Descartado.

## Consequências
- Nenhuma mídia servida tem EXIF/GPS. Isso entra como teste automatizado com uma fixture de JPEG com GPS.
- A publicação de foto é assíncrona (normalmente segundos). O app mostra "publicando" e faz polling do post.
- Assinar URLs custa CPU na API (barato). As URLs expiram, então telas abertas por mais de 6 h recarregam.
