/**
 * proforma.ts - Parse TopPIC proteoform annotations (ProForma-like format)
 * from the "Proteoform" column in prsm.tsv files into pure sequence + modifications list.
 *
 * Previously this parsing was done server-side in a deprecated bundle resolver;
 * this module provides the client-side equivalent for MS2SequenceViewer and
 * other tools that need to work with proteoform annotations directly.
 *
 * Supported input formats:
 *   "NEKVEEAPK..."                     plain sequence, no modifications
 *   "[Acetyl]-ATKRS..."                N-terminal acetylation
 *   "(MAK...DDD)[+235.1809]YEDG..."    mass shift on a subsequence
 *   "[Acetyl]-SGR...IQ(GI)[+0.9870]TKPA..."  combination of both
 */

import type { Modification } from '@/composables/ms2-sequence/fragmentation'

export interface ParsedProteoform {
  sequence: string
  modifications: Modification[]
}

// Matches N-terminal modification: [Name]-
// e.g., [Acetyl]-, [Carbamidomethyl]-
const NTERM_MOD_RE = /^\[([^\]]+)\]-/

// Matches a modified subsequence block: (SUBSEQ)[+mass] or (SUBSEQ)[-mass]
// e.g., (GI)[+0.9870], (MAK...DDD)[+235.1809]
const MODIFIED_BLOCK_RE = /\(([A-Z]+)\)\[([+-]\d+(?:\.\d+)?)\]/

// Matches a run of plain amino acid letters
const PLAIN_AA_RE = /^[A-Z]+/

/**
 * Parse a proteoform annotation string from the prsm.tsv "Proteoform" column
 * into a pure sequence and a list of modifications.
 *
 * @param raw - The raw proteoform annotation string from prsm.tsv
 * @returns ParsedProteoform with cleaned sequence and modification array
 *
 * @example
 *   parseProteoformAnnotation("NEKVEEAPK")
 *   // => { sequence: "NEKVEEAPK", modifications: [] }
 *
 * @example
 *   parseProteoformAnnotation("[Acetyl]-ATKRSVGTLKEGDLKGKRVFVR")
 *   // => { sequence: "ATKRSVGTLKEGDLKGKRVFVR",
 *   //      modifications: [{ name: "Acetyl", position: 1, type: "ptm", massShift: 0 }] }
 *
 * @example
 *   parseProteoformAnnotation("(MAKIGKPSAPPKIADDAPAKDKAKKPQPPRDTEDDD)[+235.1809]YEDGDIATPKRDRYGPD")
 *   // => { sequence: "MAKIGKPSAPPKIADDAPAKDKAKKPQPPRDTEDDDYEDGDIATPKRDRYGPD",
 *   //      modifications: [{ name: "+235.1809", position: 1, positionEnd: 36,
 *   //                        massShift: 235.1809, type: "massShift" }] }
 */
export function parseProteoformAnnotation(raw: string): ParsedProteoform {
  const input = raw.trim()
  if (!input) {
    return { sequence: '', modifications: [] }
  }

  const modifications: Modification[] = []
  const sequenceParts: string[] = []
  let remaining = input
  let pos = 1
  let autoIdCounter = 0

  // Step 1: Handle N-terminal modification like [Acetyl]-
  // This also covers NME_ACETYLATION (same textual format; semantic
  // interpretation -- initiator Met removed + N-term acetylation -- is
  // left to the caller).
  const ntermMatch = NTERM_MOD_RE.exec(remaining)
  if (ntermMatch) {
    modifications.push({
      id: `proforma-mod-${++autoIdCounter}`,
      name: ntermMatch[1],
      type: 'ptm',
      position: 1,
      massShift: 0,
    })
    remaining = remaining.slice(ntermMatch[0].length)
  }

  // Step 2: Walk the remaining string extracting modified blocks and plain AA runs
  while (remaining.length > 0) {
    const blockMatch = MODIFIED_BLOCK_RE.exec(remaining)

    if (blockMatch !== null && blockMatch.index === 0) {
      // Process modified subsequence block: (SUBSEQ)[+mass]
      const subseq = blockMatch[1]
      const massStr = blockMatch[2]
      const massShift = parseFloat(massStr)
      const endPos = pos + subseq.length - 1

      modifications.push({
        id: `proforma-mod-${++autoIdCounter}`,
        name: massStr,
        type: 'massShift',
        position: pos,
        positionEnd: endPos,
        massShift,
      })

      sequenceParts.push(subseq)
      pos += subseq.length
      remaining = remaining.slice(blockMatch[0].length)
    } else {
      // Check for a run of plain amino acid letters
      const plainMatch = PLAIN_AA_RE.exec(remaining)
      if (plainMatch !== null) {
        sequenceParts.push(plainMatch[0])
        pos += plainMatch[0].length
        remaining = remaining.slice(plainMatch[0].length)
      } else {
        // Skip non-AA characters (e.g., the dash in "F-LENVIRDAVT...")
        remaining = remaining.slice(1)
      }
    }
  }

  return {
    sequence: sequenceParts.join(''),
    modifications,
  }
}

/**
 * Generate a ProForma-like string from sequence and modifications.
 *
 * This replicates the logic from MS2SequenceViewer.buildProformaFromInput().
 * For each residue, it appends the signed mass shift in brackets (e.g., `A[+42.0106]BC`).
 * Modifications with zero or non-finite massShift are omitted from the output.
 *
 * @param sequence - The pure amino acid sequence
 * @param modifications - Array of modifications to encode
 * @returns ProForma-like string
 *
 * @example
 *   buildProformaString("ATK", [
 *     { id: "m1", name: "Acetyl", position: 1, type: "ptm", massShift: 42.0106 }
 *   ])
 *   // => "A[+42.0106]TK"
 */
export function buildProformaString(sequence: string, modifications: Modification[]): string {
  if (!sequence) return ''

  const byPosition = new Map<number, Modification[]>()
  for (const mod of modifications) {
    const arr = byPosition.get(mod.position) || []
    arr.push(mod)
    byPosition.set(mod.position, arr)
  }

  const chunks: string[] = []
  for (let i = 0; i < sequence.length; i++) {
    const pos = i + 1
    chunks.push(sequence[i])
    const posMods = byPosition.get(pos) || []
    for (const mod of posMods) {
      const mass = Number(mod.massShift)
      if (Number.isFinite(mass) && mass !== 0) {
        const signedMass = mass >= 0 ? `+${mass.toFixed(4)}` : mass.toFixed(4)
        chunks.push(`[${signedMass}]`)
      }
    }
  }

  return chunks.join('')
}
