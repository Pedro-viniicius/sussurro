/** Pedido de URL PUT pré-assinada (ADR 0009). */
export interface PresignPutInput {
  key: string;
  /** Assinado: o S3 recusa outro `Content-Type`. */
  contentType: string;
  /** Assinado: o S3 recusa um corpo de outro tamanho (MID-03). */
  contentLength: number;
  expiresInS: number;
  /** Momento da assinatura (vem do `Clock`, para os testes controlarem a validade). */
  signingDate: Date;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | undefined;
}

/**
 * Porta do armazenamento de objetos usado pela API (S3 em produção, SeaweedFS em dev, fake em
 * memória nos testes sem Docker). A API só assina uploads, confere objetos (HEAD) e apaga; ler e
 * gravar bytes é com o worker.
 */
export abstract class ObjectStorage {
  abstract presignPut(input: PresignPutInput): Promise<string>;
  /** `null` se o objeto não existe. */
  abstract head(key: string): Promise<ObjectHead | null>;
  /** Idempotente: chave inexistente não é erro. */
  abstract deleteObjects(keys: readonly string[]): Promise<void>;
}

/**
 * Porta das URLs de leitura da mídia: assinadas e com validade (ADR 0009). Só são geradas depois
 * do `AccessPolicyService` (PERM-16).
 */
export abstract class MediaUrlSigner {
  abstract sign(key: string, expiresAt: Date, signingDate: Date): Promise<string>;
}
