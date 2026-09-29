/**
 * Node projection — mirrors the backend's manifest-less scan output.
 *
 * A node is a self-contained directory under <dataRoot>/nodes/<id>/:
 *   rules.smk (the declaration: rules = capabilities, params/inputs/outputs
 *             are parsed from it), README.md (prose usage), binaries.
 * No manifest file. id = dir name, digest = content sha256.
 */

export interface NodeCapabilityField {
  name: string
  pattern: string
}

export interface NodeCapability {
  /** rule name in rules.smk — the callable unit of work */
  name: string
  inputs: NodeCapabilityField[]
  outputs: NodeCapabilityField[]
  params: NodeCapabilityField[]
  /** `message:` directive text, or empty */
  message: string
}

export interface NodeProjection {
  id: string
  version: string
  digest: string
  /** inferred from binaries present; the engine resolves the right one at runtime */
  platforms: string[]
  description: string
  /** one per `rule` block in rules.smk */
  capabilities: NodeCapability[]
  /** full rules.smk text — the authoritative contract */
  rulesText: string
  /** README.md text, or empty */
  readme: string
}
