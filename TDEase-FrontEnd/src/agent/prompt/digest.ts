import type { Sha256, Sha256Digest } from './types'
import { bufferToHex } from '@/utils/hex'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class InvalidSha256Error extends Error {
  constructor(value: string) {
    super(`Expected a lowercase SHA-256 digest, received ${JSON.stringify(value)}`)
    this.name = 'InvalidSha256Error'
  }
}

export function assertSha256(value: string): asserts value is Sha256 {
  if (!SHA256_PATTERN.test(value)) throw new InvalidSha256Error(value)
}

/**
 * Web Crypto adapter. Keep it injectable: jsdom/headless callers can supply a
 * deterministic digest port without needing a browser global.
 */
export function createWebCryptoSha256Digest(
  webCrypto: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Sha256Digest {
  return {
    async sha256(content: string): Promise<Sha256> {
      if (!webCrypto?.subtle) {
        throw new Error('Web Crypto subtle.digest is unavailable; inject a Sha256Digest for this runtime')
      }
      const bytes = new TextEncoder().encode(content)
      const digest = await webCrypto.subtle.digest('SHA-256', bytes as BufferSource)
      const value = bufferToHex(digest)
      assertSha256(value)
      return value
    },
  }
}

/** Default production adapter; evaluated only when a digest is requested. */
export const webCryptoSha256Digest: Sha256Digest = {
  sha256: (content) => createWebCryptoSha256Digest().sha256(content),
}
