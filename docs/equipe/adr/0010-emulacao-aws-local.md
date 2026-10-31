# ADR 0010: Emulação local de S3 e SQS

- Status: ~~proposto, **decisão do PO**~~ Aceita (PO, 2026-10-29: D2, ElasticMQ + SeaweedFS) · Data: 2026-10-29
- (revisto em 2026-10-31) Status atualizado: o PO decidiu o D2 pela recomendação desta ADR ao aprovar o plano em 2026-10-29 (`PROJETO.md`, topo e §8.1). A "Decisão (recomendada)" abaixo é a que vale; o compose e o CI usam o ElasticMQ e o SeaweedFS (`arquitetura.md` §16, R9).

## Contexto
A especificação pede LocalStack ou uma fila local com a mesma interface. Fatos verificados em 2026-10-29:
- Desde a versão 2026.03.0, o LocalStack usa imagem única que **exige conta e `LOCALSTACK_AUTH_TOKEN`**, inclusive no CI. O plano gratuito (Hobby) é para uso **não comercial**. Os planos pagos começam por volta de US$ 39 por licença/mês.
- A edição comunitária do MinIO foi arquivada e deixou de publicar imagens (2025–2026), então não serve como alternativa.

## Decisão (recomendada)
- **SQS**: ElasticMQ (Apache-2.0, compatível com a API SQS).
- **S3**: SeaweedFS no modo `s3` (Apache-2.0).
- O código usa sempre o AWS SDK v3 com `AWS_ENDPOINT_URL` e `forcePathStyle` vindos do ambiente. Trocar de emulador ou ir para a AWS real é só configuração.
- Spike na Fase 0 valida PUT pré-assinado, `HEAD`, `DeleteObject`, DLQ e visibility timeout. Se algo falhar, a alternativa é o LocalStack.

## Alternativas
- **LocalStack com auth token**: um container para tudo e o mais fiel à AWS, mas cria dependência de conta e licença (provavelmente paga, se o Sussurro for comercial) e exige segredo no CI.
- **Floci/MiniStack**: emuladores gratuitos novos, sem histórico suficiente.
- **AWS real (conta de dev)**: o mais fiel, mas tem custo, exige internet e não funciona offline nem no CI sem credenciais.

## Consequências
- Dois containers em vez de um, mas gratuitos e sem conta.
- MediaConvert e EventBridge não são emulados. O `PassthroughVideoProcessor` cobre o dev (ADR 0006).
