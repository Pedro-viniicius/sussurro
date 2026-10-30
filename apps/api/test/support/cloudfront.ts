import { verify } from 'node:crypto';

/**
 * Confere uma URL assinada do CloudFront com política "canned" como o CloudFront faria: refaz a
 * política com o recurso (URL sem a query) e o `Expires`, e verifica a assinatura RSA-SHA1 com a
 * chave pública do key group. Também recusa URL vencida. É o que garante, no teste, que uma URL
 * adulterada ou sem assinatura não vale (PERM-16).
 */
export function isValidCloudFrontUrl(url: string, publicKey: string, now: Date): boolean {
  const parsed = new URL(url);
  const expires = parsed.searchParams.get('Expires');
  const signature = parsed.searchParams.get('Signature');
  const keyPairId = parsed.searchParams.get('Key-Pair-Id');
  if (expires === null || signature === null || keyPairId === null) {
    return false;
  }
  if (Number(expires) * 1000 <= now.getTime()) {
    return false;
  }
  const resource = `${parsed.origin}${parsed.pathname}`;
  const policy = JSON.stringify({
    Statement: [
      { Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': Number(expires) } } },
    ],
  });
  const raw = Buffer.from(
    signature.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'),
    'base64',
  );
  return verify('RSA-SHA1', Buffer.from(policy), publicKey, raw);
}
