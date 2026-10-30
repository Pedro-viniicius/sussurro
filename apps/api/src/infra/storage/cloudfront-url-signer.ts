import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

import { MediaUrlSigner } from './object-storage.js';

export interface CloudFrontSettings {
  /** `media.dominio` (sem protocolo) ou uma URL https. */
  domain: string;
  keyPairId: string;
  /** Chave privada RSA (PEM) do trusted key group. */
  privateKey: string;
}

/** Monta a URL pública do objeto, codificando cada segmento da chave. */
export function cloudFrontObjectUrl(domain: string, key: string): string {
  const base = /^https?:\/\//.test(domain) ? domain.replace(/\/+$/, '') : `https://${domain}`;
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * URLs assinadas do CloudFront (ADR 0009) com política "canned" (só validade), pelo
 * `@aws-sdk/cloudfront-signer`. Sem a chave privada do key group não dá para gerar nem alterar uma
 * URL: CloudFront responde 403 a assinatura adulterada ou ausente (PERM-16).
 */
export class CloudFrontMediaUrlSigner extends MediaUrlSigner {
  constructor(private readonly settings: CloudFrontSettings) {
    super();
  }

  sign(key: string, expiresAt: Date): Promise<string> {
    return Promise.resolve(
      getSignedUrl({
        url: cloudFrontObjectUrl(this.settings.domain, key),
        keyPairId: this.settings.keyPairId,
        privateKey: this.settings.privateKey,
        dateLessThan: expiresAt,
      }),
    );
  }
}
