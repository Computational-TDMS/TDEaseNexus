/**
 * Content-addressed store for large reference results, reusing the atomic
 * `wx` create pattern proven by `spectra-command-port.writeResultOnce`: a
 * SHA-256 names the file, an exclusive create wins once per digest, and
 * parallel identical requests converge. The reference prefix is `ref_<sha256>`
 * so it is never confused with the spectra `msr_` namespace.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface StoredResult {
  id: string
  sha256: string
  size: number
  mediaType: string
}

export class ReferenceResultStore {
  constructor(private readonly root: string) {}

  async writeOnce(content: string, mediaType = 'application/json'): Promise<StoredResult> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const target = path.join(this.root, `${sha256}.json`)
    await fs.mkdir(this.root, { recursive: true })
    try {
      await fs.access(target)
    } catch {
      // Exclusive create; a concurrent identical write converges harmlessly.
      const handle = await fs.open(target, 'wx')
      try {
        await handle.writeFile(content, 'utf8')
      } finally {
        await handle.close()
      }
    }
    return { id: `ref_${sha256}`, sha256, size: Buffer.byteLength(content), mediaType }
  }

  async read(sha256: string): Promise<string> {
    const content = await fs.readFile(path.join(this.root, `${sha256}.json`), 'utf8')
    const verify = createHash('sha256').update(content).digest('hex')
    if (verify !== sha256) throw new Error('REFERENCE_RESULT_CORRUPT: cached digest mismatch')
    return content
  }
}
