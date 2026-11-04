import type {
  SourcePolicy,
  UniProtFormat,
  UniProtGetInput,
  UniProtQueryInput,
  UniProtResource,
} from '../../ports/reference-command-port'
import type { CommandDefinition } from '../registry'
import {
  objectSchema, optionalBoolean, optionalInteger, optionalNumber, optionalRecord, optionalString,
  optionalStringArray, requiredString, stringSchema,
} from '../args'

// UniProt is a local-first read-through store that survives disconnect.
// Exact mass, ProForma and UniMod calculations are invoked directly through
// `tdeasenexus-toolbox` in bash; this command family deliberately owns no CLI adapter.
export function referenceCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'uniprot.get', title: 'Read UniProt Entry',
      exposure: { mindsets: 'all' },
      summary: 'Read one official UniProtKB/UniRef/UniParc record from the local-first store. Local analyst assertions are excluded by default; request includeAssertions only when prior local knowledge is part of the task.',
      args: objectSchema({
        resource: { type: 'string', enum: ['uniprotkb', 'uniref', 'uniparc', 'proteomes', 'taxonomy'] },
        id: stringSchema(),
        fields: { type: 'array', items: stringSchema() },
        format: { type: 'string', enum: ['json', 'tsv', 'fasta', 'xml', 'txt', 'gff', 'rdf', 'normalized'] },
        includeAssertions: { type: 'boolean' },
        sourcePolicy: objectSchema({
          mode: { type: 'string', enum: ['local-only', 'local-first', 'remote-refresh', 'pinned'] },
          maxAgeDays: { type: 'integer', minimum: 1 },
          allowStaleOnFailure: { type: 'boolean' },
          snapshotDigest: { ...stringSchema(), pattern: '^[a-f0-9]{64}$' },
        }),
      }, ['resource', 'id']),
      mutates: false,
      enabled: (context) => Boolean(context.references),
      run: (args, context, execution) => {
        const references = context.references
        if (!references) throw new Error('Reference tools are unavailable in this session')
        return references.uniprotGet(buildUniProtGetInput(args), execution?.signal)
      },
    },
    {
      id: 'uniprot.query', title: 'Query UniProt Set',
      exposure: { mindsets: 'all' },
      summary: 'Search a UniProt resource. Put native UniProt syntax such as "gene:H2AFX AND organism_id:10090" in advancedQuery, never query. query is only the structured { all: [{ field, eq }] } / { any: [...] } form. Results are locally cached, strictly field-projected before model delivery, and oversized results return a compact preview plus resultRef.',
      args: objectSchema({
        resource: { type: 'string', enum: ['uniprotkb', 'uniref', 'uniparc', 'proteomes', 'taxonomy', 'homology'] },
        query: { type: 'object' },
        advancedQuery: stringSchema(),
        fields: { type: 'array', items: stringSchema() },
        format: { type: 'string', enum: ['json', 'tsv', 'fasta', 'xml', 'txt', 'gff', 'rdf', 'normalized'] },
        mode: { type: 'string', enum: ['page', 'stream'] },
        cursor: stringSchema(),
        pageSize: { type: 'integer', minimum: 1, maximum: 500 },
        includeIsoform: { type: 'boolean' },
        sourcePolicy: objectSchema({
          mode: { type: 'string', enum: ['local-only', 'local-first', 'remote-refresh'] },
          maxAgeDays: { type: 'integer', minimum: 1 },
          allowStaleOnFailure: { type: 'boolean' },
        }),
        // homology
        seed: objectSchema({ accession: stringSchema() }, ['accession']),
        discovery: objectSchema({
          unirefLevels: { type: 'array', items: { type: 'integer', enum: [100, 90, 50] } },
          reviewed: { type: 'string', enum: ['prefer', 'only'] },
          taxonomy: objectSchema({ descendantsOf: { type: 'integer', minimum: 1 } }, ['descendantsOf']),
          includeIsoforms: { type: 'boolean' },
        }),
        validation: objectSchema({
          minIdentity: { type: 'number', minimum: 0, maximum: 1 },
          minQueryCoverage: { type: 'number', minimum: 0, maximum: 1 },
          minTargetCoverage: { type: 'number', minimum: 0, maximum: 1 },
        }),
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      }, ['resource']),
      mutates: false,
      enabled: (context) => Boolean(context.references),
      run: (args, context, execution) => {
        const references = context.references
        if (!references) throw new Error('Reference tools are unavailable in this session')
        return references.uniprotQuery(buildUniProtQueryInput(args), execution?.signal)
      },
    },
    {
      id: 'uniprot.map', title: 'Map UniProt IDs',
      exposure: { mindsets: 'all' },
      summary: 'Map identifiers between UniProt and external databases through the official asynchronous ID-mapping service, recording the jobId as provenance.',
      args: objectSchema({
        from: stringSchema(),
        to: stringSchema(),
        ids: { type: 'array', minItems: 1, maxItems: 100_000, items: stringSchema() },
        maxPages: { type: 'integer', minimum: 1, maximum: 1000 },
      }, ['from', 'to', 'ids']),
      mutates: false,
      enabled: (context) => Boolean(context.references),
      run: (args, context, execution) => {
        const references = context.references
        if (!references) throw new Error('Reference tools are unavailable in this session')
        const ids = optionalStringArray(args, 'ids')
        if (!ids || ids.length === 0) throw new Error('uniprot.map requires at least one id')
        return references.uniprotMap({
          from: requiredString(args, 'from'),
          to: requiredString(args, 'to'),
          ids,
          maxPages: optionalInteger(args, 'maxPages'),
        }, execution?.signal)
      },
    },
    {
      id: 'uniprot.blast', title: 'BLAST a Protein Fragment',
      exposure: { mindsets: 'all' },
      summary: 'Search protein sequence through EBI ncbiblast and return aligned UniProt hits. Choose database and taxids from the carrier: for an unreviewed protein use database:"uniprotkb" with the nearest useful taxonomic clade, not the Swiss-Prot default alone. Use full sequence for family discovery and querySite for later site transfer. Reject low-complexity-only matches without compatible boundary alignment and protein family/length. Reference data, not sample evidence.',
      args: objectSchema({
        sequence: stringSchema(),
        database: { type: 'string', default: 'uniprotkb_swissprot' },
        program: { type: 'string', default: 'blastp' },
        matrix: { type: 'string', default: 'BLOSUM62' },
        threshold: { type: 'number', default: 1e-4 },
        taxids: { type: 'array', items: { type: 'string' } },
        querySite: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      }, ['sequence']),
      mutates: false,
      enabled: (context) => Boolean(context.references),
      run: (args, context, execution) => {
        const references = context.references
        if (!references) throw new Error('Reference tools are unavailable in this session')
        const sequence = requiredString(args, 'sequence')
        const taxids = optionalStringArray(args, 'taxids')
        const querySite = optionalInteger(args, 'querySite')
        const limit = optionalInteger(args, 'limit')
        return references.uniprotBlast({
          sequence,
          database: optionalString(args, 'database'),
          program: optionalString(args, 'program'),
          matrix: optionalString(args, 'matrix'),
          threshold: optionalNumber(args, 'threshold'),
          taxids,
          querySite,
          limit,
        }, execution?.signal)
      },
    },
    {
      id: 'uniprot.note', title: 'Note Reference Fact',
      exposure: { mindsets: 'all' },
      summary: 'Record a local note about a UniProt entry — a hypothesis, correction, or confirmation that evolves over time. The overlay is merged on read and never overwrites the remote authority record.',
      args: objectSchema({
        resource: { type: 'string', enum: ['uniprotkb', 'uniref', 'uniparc', 'proteomes', 'taxonomy'] },
        id: stringSchema(),
        subject: stringSchema(),
        predicate: stringSchema(),
        value: stringSchema(),
        verdict: { type: 'string', enum: ['confirmed', 'rejected', 'supplemented'] },
        evidenceRefs: { type: 'array', items: stringSchema() },
        basedOnSnapshot: { ...stringSchema(), pattern: '^[a-f0-9]{64}$' },
        notedBy: stringSchema(),
        comment: stringSchema(),
      }, ['resource', 'id', 'subject', 'predicate', 'value', 'verdict']),
      // A reversible local overlay — cheap, auditable, never destructive to the
      // authority record. The approval card carries everything there is to read.
      mutates: true, permission: 'reference.note', stakes: 'inline',
      enabled: (context) => Boolean(context.references),
      run: (args, context) => {
        const references = context.references
        if (!references) throw new Error('Reference tools are unavailable in this session')
        return references.note({
          resource: requiredString(args, 'resource') as UniProtResource,
          id: requiredString(args, 'id'),
          subject: requiredString(args, 'subject'),
          predicate: requiredString(args, 'predicate'),
          value: requiredString(args, 'value'),
          verdict: requiredString(args, 'verdict') as 'confirmed' | 'rejected' | 'supplemented',
          evidenceRefs: optionalStringArray(args, 'evidenceRefs'),
          basedOnSnapshot: optionalString(args, 'basedOnSnapshot'),
          notedBy: optionalString(args, 'notedBy'),
          comment: optionalString(args, 'comment'),
        })
      },
    },
    {
      id: 'uniprot.revise', title: 'Revise Reference Note',
      exposure: { mindsets: 'all' },
      summary: 'Revise a local reference note: sharpen its value, add or replace evidence, update the verdict, comment, or retract it. One entry point for everything that happens to a note after it is created.',
      args: objectSchema({
        noteId: { ...stringSchema(), pattern: '^refn_[a-f0-9]{16}$' },
        value: stringSchema(),
        verdict: { type: 'string', enum: ['confirmed', 'rejected', 'supplemented'] },
        evidenceRefs: { type: 'array', items: stringSchema() },
        appendEvidence: { type: 'boolean' },
        comment: stringSchema(),
        retracted: { type: 'boolean' },
      }, ['noteId']),
      mutates: true, permission: 'reference.note', stakes: 'inline',
      enabled: (context) => Boolean(context.references),
      run: (args, context) => {
        const references = context.references
        if (!references) throw new Error('Reference tools are unavailable in this session')
        return references.revise({
          noteId: requiredString(args, 'noteId'),
          value: optionalString(args, 'value'),
          verdict: optionalString(args, 'verdict') as 'confirmed' | 'rejected' | 'supplemented' | undefined,
          evidenceRefs: optionalStringArray(args, 'evidenceRefs'),
          appendEvidence: typeof args.appendEvidence === 'boolean' ? args.appendEvidence : undefined,
          comment: optionalString(args, 'comment'),
          retracted: typeof args.retracted === 'boolean' ? args.retracted : undefined,
        })
      },
    },
  ] satisfies CommandDefinition[])
}

function buildUniProtGetInput(args: Record<string, unknown>): UniProtGetInput {
  const resource = requiredString(args, 'resource') as UniProtResource
  const policy = optionalRecord(args, 'sourcePolicy')
  return {
    resource,
    id: requiredString(args, 'id'),
    fields: optionalStringArray(args, 'fields'),
    format: optionalString(args, 'format') as UniProtFormat | undefined,
    includeAssertions: optionalBoolean(args, 'includeAssertions'),
    sourcePolicy: policy && policy.mode ? (policy as unknown as SourcePolicy) : undefined,
  }
}

function buildUniProtQueryInput(args: Record<string, unknown>): UniProtQueryInput {
  const resource = requiredString(args, 'resource') as UniProtResource
  const policy = optionalRecord(args, 'sourcePolicy')
  const mode = optionalString(args, 'mode')
  const seed = optionalRecord(args, 'seed')
  const discovery = optionalRecord(args, 'discovery')
  return {
    resource,
    query: optionalRecord(args, 'query') as UniProtQueryInput['query'],
    advancedQuery: optionalString(args, 'advancedQuery'),
    fields: optionalStringArray(args, 'fields'),
    format: optionalString(args, 'format') as UniProtFormat | undefined,
    mode: mode === 'stream' ? 'stream' : 'page',
    cursor: optionalString(args, 'cursor'),
    pageSize: optionalInteger(args, 'pageSize'),
    includeIsoform: optionalBoolean(args, 'includeIsoform'),
    sourcePolicy: policy && policy.mode ? (policy as unknown as SourcePolicy) : undefined,
    seed: seed?.accession ? { accession: requiredString(seed, 'accession') } : undefined,
    discovery: discovery ? (discovery as unknown as UniProtQueryInput['discovery']) : undefined,
    validation: optionalRecord(args, 'validation') as UniProtQueryInput['validation'],
    limit: optionalInteger(args, 'limit'),
  }
}
