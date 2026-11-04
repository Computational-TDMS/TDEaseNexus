import { describe, expect, it } from 'vitest'
import { webCryptoSha256Digest } from './index'

describe('webCryptoSha256Digest', () => {
  it('produces the canonical SHA-256 digest in a jsdom/headless test runtime', async () => {
    await expect(webCryptoSha256Digest.sha256('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
