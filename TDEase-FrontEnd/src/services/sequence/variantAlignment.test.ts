import { parseFasta } from '@/services/fasta'
import {
  accessionKeys,
  aggregateProteinFacts,
  alignmentSegments,
  buildVariantAlignment,
  extractDatabaseFileName,
  scanFastaRecords,
  theoreticalMass,
  wantedFastaKeys,
} from './variantAlignment'

const REAL_HEADER =
  'Data file name\tPrsm ID\tSpectrum ID\tFragmentation\tScan(s)\tRetention time\t# Masses\tCharge\tPrecursor mass\tAdjusted precursor mass\tProteoform ID\tProteoform intensity\tFeature ID\tFeature intensity\tFeature score\tFeature apex time\t# Protein hits\tProtein accession\tProtein description\tFirst residue\tLast residue\tSpecial amino acids\tDatabase protein sequence\tPrevious amino acid\tProteoform\tNext amino acid\tProteoform mass\tProtein N-terminal form\tFixed PTMs\t# Unexpected modifications\tUnexpected modifications\t# Variable PTMs\tVariable PTMs\tMIScore\t# Matched masses\t# Matched fragments\tE-value\tSpectrum-level Q-value\tProteoform-level Q-value'

function factRow(overrides: Record<string, string>): Record<string, string> {
  return {
    'Protein accession': '', 'Protein description': '', 'First residue': '', 'Last residue': '',
    'Proteoform mass': '', 'Database protein sequence': '', 'E-value': '', 'Feature intensity': '',
    ...overrides,
  }
}

/** Maps a sparse fact row onto the real TopPIC prsm.tsv column order. */
function prsmLine(row: Record<string, string>): string {
  return [
    'Glyco.msalign', '0', '26', 'HCD', '73', '0.702', '26', '4', '4847.4', '4847.4', '244', '1', '530',
    row['Feature intensity'], '0.99', '0.7', '1',
    row['Protein accession'], row['Protein description'], row['First residue'], row['Last residue'], '',
    row['Database protein sequence'], 'L', row['Database protein sequence'], '-', row['Proteoform mass'], 'NONE', '',
    '0', '', '0', '', '-', '12', '12', row['E-value'], '0', '0',
  ].join('\t')
}

function tsvTable(lines: string[]) {
  const [columns, ...rest] = [REAL_HEADER, ...lines].map((line) => line.split('\t'))
  return {
    columns: columns!,
    rows: rest.map((cells) => Object.fromEntries(columns!.map((name, index) => [name, cells[index] ?? '']))),
  }
}

function factsFromRows(rows: Record<string, string>[]) {
  return aggregateProteinFacts(tsvTable(rows.map(prsmLine)))
}

function factsFor(accession: string) {
  return factsFromRows([factRow({ 'Protein accession': accession, 'Proteoform mass': '1000' })])
}

describe('aggregateProteinFacts', () => {
  it('merges prsm rows of one accession into per-protein facts', () => {
    const facts = factsFromRows([
      factRow({
        'Protein accession': 'tr|Q2KMJ4|Q2KMJ4_SOYBN',
        'Protein description': 'EKN OS=Glycine max',
        'First residue': '59', 'Last residue': '101',
        'Database protein sequence': 'NEKVEEAPK',
        'Proteoform mass': '4847.408778', 'E-value': '5.79e-07', 'Feature intensity': '38638258.86',
      }),
      factRow({
        'Protein accession': 'tr|Q2KMJ4|Q2KMJ4_SOYBN',
        'First residue': '59', 'Last residue': '103',
        'Database protein sequence': 'NEKVEEAPKTE',
        'Proteoform mass': '5035.52', 'E-value': '1.2e-09', 'Feature intensity': '9133673.12',
      }),
      factRow({
        'Protein accession': 'tr|C6T4V4|C6T4V4_SOYBN',
        'Protein description': 'Uncharacterized protein',
        'Proteoform mass': '4435.212978',
      }),
    ])

    expect(facts.size).toBe(2)

    const ekn = facts.get('tr|Q2KMJ4|Q2KMJ4_SOYBN')!
    expect(ekn.matchCount).toBe(2)
    expect(ekn.description).toBe('EKN OS=Glycine max')
    expect(ekn.firstResidue).toBe(59)
    expect(ekn.lastResidue).toBe(103)
    expect(ekn.proteoformMasses).toEqual([4847.408778, 5035.52])
    expect(ekn.bestEValue).toBeCloseTo(1.2e-09)
    expect(ekn.maxIntensity).toBe(38638258.86)
    expect(ekn.spanSequence).toBe('NEKVEEAPKTE')

    const other = facts.get('tr|C6T4V4|C6T4V4_SOYBN')!
    expect(other.matchCount).toBe(1)
    expect(other.description).toBe('Uncharacterized protein')
  })

  it('extracts the database file name from a TopPIC preamble', () => {
    const raw = [
      '********************** Parameters **********************',
      'Protein database file:                        \tGlycine.fasta',
      'Spectrum file:                               \tsample_ms2.msalign',
      'Number of identified proteoforms: 446',
    ].join('\n')
    expect(extractDatabaseFileName(raw)).toBe('Glycine.fasta')
    expect(extractDatabaseFileName('no preamble here\njust text')).toBeNull()
  })
})

describe('accessionKeys', () => {
  it('expands pipe tokens and lowercases', () => {
    expect(accessionKeys('tr|Q2KMJ4|Q2KMJ4_SOYBN')).toEqual(['tr|q2kmj4|q2kmj4_soybn', 'q2kmj4', 'q2kmj4_soybn'])
    expect(accessionKeys('sp|P62805|H4_HUMAN')).toEqual(['sp|p62805|h4_human', 'p62805', 'h4_human'])
    expect(accessionKeys('Plain_Id1')).toEqual(['plain_id1'])
    expect(accessionKeys('  ')).toEqual([])
  })
})

describe('theoreticalMass', () => {
  it('sums residue masses plus water', () => {
    // G + H2O = 57.021463735 + 18.0105646863
    expect(theoreticalMass('G')).toBeCloseTo(75.0320284213, 6)
    // A + G + H2O
    expect(theoreticalMass('AG')).toBeCloseTo(75.0320284213 + 71.037113805, 6)
  })

  it('refuses to claim a mass over ambiguous residues', () => {
    expect(theoreticalMass('AGX')).toBeNull()
    expect(theoreticalMass('')).toBeNull()
  })
})

describe('buildVariantAlignment', () => {
  const fasta = parseFasta([
    '>sp|P1|VAR_ONE first variant',
    'MKTVL',
    '>sp|P2|VAR_TWO second variant',
    'MKTAL',
    '>sp|P3|VAR_THREE insertion variant',
    'MKTGAL',
    '>sp|P9|FAMILY_OTHER unrelated family member',
    'AAAAA',
  ].join('\n'))

  it('aligns identical-length variants without gaps and reports column conservation', () => {
    const facts = new Map([...factsFor('sp|P1|VAR_ONE'), ...factsFor('sp|P2|VAR_TWO')])
    const model = buildVariantAlignment({ fasta, facts })

    expect(model.rows).toHaveLength(2)
    expect(model.rows[0]!.accession).toBe('sp|P1|VAR_ONE')
    expect(model.rows[0]!.state).toBe('reference')
    expect(model.rows[1]!.alignedSequence).toBe('MKTAL')
    expect(model.columnCount).toBe(5)
    // column 3 is a 50/50 T/A tie; the consensus resolves it deterministically
    expect(model.consensus).toBe('MKTAL')
    expect(model.conservation.filter((c) => c === 1)).toHaveLength(4)
    expect(model.conservation[3]).toBeCloseTo(0.5)
    expect(model.rows.every((row) => row.identified)).toBe(true)
    expect(model.rows[0]!.theoreticalMass).toBeCloseTo(theoreticalMass('MKTVL')!, 6)
    expect(model.rows[0]!.facts?.proteoformMasses).toEqual([1000])
  })

  it('represents an insertion in a variant as a shared reference-gap column', () => {
    const facts = new Map([...factsFor('sp|P1|VAR_ONE'), ...factsFor('sp|P3|VAR_THREE')])
    const model = buildVariantAlignment({ fasta, facts })

    // the reference is the longest identified sequence (P3), so the shorter
    // P1 carries the gap inside the merged column space
    expect(model.referenceAccession).toBe('sp|P3|VAR_THREE')
    expect(model.columnCount).toBe(6)
    expect(model.rows[0]!.alignedSequence).toBe('MKTGAL')
    expect(model.rows[1]!.alignedSequence).toBe('MKT-VL')
    const gapColumn = model.rows[1]!.alignedSequence.indexOf('-')
    expect(model.consensus[gapColumn]).toBe('G')
  })

  it('pulls in un-identified family members only through the filter', () => {
    const facts = factsFor('sp|P1|VAR_ONE')
    const withoutFilter = buildVariantAlignment({ fasta, facts })
    expect(withoutFilter.familyCount).toBe(0)
    expect(withoutFilter.rows).toHaveLength(1)

    const withFilter = buildVariantAlignment({ fasta, facts, filter: 'var_' })
    // P2 and P3 match; the identified P1 is already a row, not family
    expect(withFilter.familyCount).toBe(2)
    expect(withFilter.rows.map((row) => row.accession)).toEqual([
      'sp|P1|VAR_ONE', 'sp|P2|VAR_TWO', 'sp|P3|VAR_THREE',
    ])
    expect(withFilter.rows.every((row) => row.identified || row.facts === null)).toBe(true)
  })

  it('falls back to the TSV span sequence and marks the row span-only when the FASTA lacks the accession', () => {
    const model = buildVariantAlignment({
      fasta,
      facts: factsFor('sp|P8|MISSING_FROM_FASTA'),
    })
    const spanRow = model.rows[0]!
    expect(spanRow.accession).toBe('sp|P8|MISSING_FROM_FASTA')
    expect(spanRow.state).toBe('span-only')
    expect(spanRow.identified).toBe(true)
    expect(spanRow.alignedSequence).toBe('')
  })

  it('falls back to the span sequence carried in the TSV when present', () => {
    const facts = factsFromRows([factRow({
      'Protein accession': 'sp|P8|MISSING_FROM_FASTA',
      'First residue': '2', 'Last residue': '4',
      'Database protein sequence': 'KTV',
    })])
    const model = buildVariantAlignment({ fasta, facts })
    expect(model.rows[0]!.state).toBe('span-only')
    expect(model.rows[0]!.alignedSequence).toBe('KTV')
    expect(model.rows[0]!.theoreticalMass).toBeCloseTo(theoreticalMass('KTV')!, 6)
  })
})

describe('alignmentSegments', () => {
  it('compresses runs and classifies match/mismatch/gap', () => {
    // columns: M=a, K=a, T vs S mismatch, - gap, L=a
    const segments = alignmentSegments('MKT-L', 'MKSVL', 0, 5)
    expect(segments).toEqual([
      { text: 'MK', type: 'match' },
      { text: 'T', type: 'mismatch' },
      { text: '-', type: 'gap' },
      { text: 'L', type: 'match' },
    ])
  })

  it('treats columns beyond the row as gaps', () => {
    expect(alignmentSegments('MK', 'MKTL', 2, 4)).toEqual([{ text: '--', type: 'gap' }])
  })
})

describe('scanFastaRecords', () => {
  const text = [
    '>sp|P1|VAR_ONE first',
    'MKTV',
    'LAAA',
    '>sp|P2|VAR_TWO second',
    'MKTAL',
    '',
    '>tr|Q9|OTHER other',
    'GG',
  ].join('\n')
  const bytes = new TextEncoder().encode(text)
  const reader = async (start: number, end: number) => bytes.slice(start, end)

  it('collects all records across awkward chunk boundaries', async () => {
    const document = await scanFastaRecords(reader, bytes.length, { chunkBytes: 7 })
    expect(document.records.map((record) => record.id)).toEqual(['sp|P1|VAR_ONE', 'sp|P2|VAR_TWO', 'tr|Q9|OTHER'])
    expect(document.records[0]!.sequence).toBe('MKTVLAAA')
    expect(document.records[0]!.description).toBe('first')
    expect(document.invalidLineCount).toBe(0)
    expect(document.totalResidues).toBe(4 + 4 + 5 + 2)
  })

  it('retains only wanted accessions through their pipe tokens', async () => {
    const wanted = wantedFastaKeys(factsFor('tr|Q9|OTHER'))
    expect(wanted.has('q9')).toBe(true)

    const document = await scanFastaRecords(reader, bytes.length, { wanted, chunkBytes: 5 })
    expect(document.records.map((record) => record.id)).toEqual(['tr|Q9|OTHER'])
    expect(document.records[0]!.sequence).toBe('GG')
    // skipped records' sequence lines must not count as invalid
    expect(document.invalidLineCount).toBe(0)
  })
})
