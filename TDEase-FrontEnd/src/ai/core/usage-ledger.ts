// TDEase usage ledger — records per-LLM-call usage entries to a System JSON file.
//
// Trimmed port of openhanako's lib/llm/usage-ledger.ts + usage-observer.ts,
// narrowed to TDEase's UsageEntry shape (a strict subset of openhanako's
// normalized usage). The ledger is owned by the Electron main process; the
// renderer only reads via IPC and subscribes to live appends.
//
// Design notes:
//   - storagePath is optional: null = in-memory only (used by tests and when
//     the System dir is not yet known). When set, appends coalesce onto disk:
//     the write is marked dirty and flushed once after PERSIST_DEBOUNCE_MS, so
//     a streaming burst of finishes costs one atomic rewrite (temp + rename),
//     not one per entry. Reads always see memory, so stats stay exact; a hard
//     kill inside the window loses at most a second of usage rows — degraded
//     metrics, never broken requests. clear() flushes synchronously.
//   - The set is bounded by maxEntries (FIFO). With debounced writes the bound
//     is high enough that a heavy daily driver (hundreds of LLM calls a day)
//     stays inside it for months — the 30d/"all" ranges never silently lose
//     their tail the way a low cap would.
//   - normalizeUsage accepts Pi ({input,output,cacheRead,cacheWrite,totalTokens}),
//     Anthropic ({input_tokens,...}), and OpenAI-compatible ({prompt_tokens,...})
//     payloads — same coverage as openhanako, so a provider switch never silently
//     drops tokens.
//   - Cost is computed from the model's costRates when the provider doesn't
//     report one. Custom OpenAI-compatible endpoints cost nothing until the
//     user declares a price (providers.<id>.models.<modelId>.cost in
//     settings.json), which matches "TDEase does not bill; users bring their
//     own API key".

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface UsageModel {
  provider: string | null;
  modelId: string | null;
  api: string | null;
}

export interface NormalizedUsage {
  input: { totalTokens: number; uncachedTokens: number | null };
  output: { totalTokens: number; reasoningTokens: number | null };
  cache: { readTokens: number | null; writeTokens: number | null; hitRatio: number | null };
  totalTokens: number;
  costTotal: number | null;
}

export interface UsageEntry {
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "ok" | "error" | "aborted" | "usage_missing";
  model: UsageModel;
  usage: NormalizedUsage | null;
  error: { name: string | null; message: string | null } | null;
}

export interface CostRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UsageLedgerStartMeta {
  model?: Partial<UsageModel>;
  costRates?: CostRates | null;
}

export interface UsageLedgerResult {
  usage?: unknown;
  model?: Partial<UsageModel>;
  costRates?: CostRates | null;
}

export type UsageEntryListener = (entry: UsageEntry) => void;

export interface UsageLedger {
  start(meta?: UsageLedgerStartMeta): { requestId: string; startedAt: string };
  finish(requestId: string, result?: UsageLedgerResult): UsageEntry | null;
  recordError(
    requestId: string,
    error: unknown,
    status: "error" | "aborted",
    result?: UsageLedgerResult,
  ): UsageEntry | null;
  list(filter?: UsageListFilter): UsageEntry[];
  subscribe(listener: UsageEntryListener): () => void;
  clear(): void;
  /** Force the debounced persistence write now (app quit, diagnostics). */
  flush(): void;
}

export interface UsageListFilter {
  limit?: number;
  since?: string;
  until?: string;
  status?: UsageEntry["status"];
  provider?: string;
  modelId?: string;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const STORAGE_VERSION = 1;
/** Appends inside this window coalesce into a single atomic rewrite. */
const PERSIST_DEBOUNCE_MS = 1_500;

export function createUsageLedger({
  maxEntries = DEFAULT_MAX_ENTRIES,
  storagePath = null,
  now = () => Date.now(),
}: {
  maxEntries?: number;
  storagePath?: string | null;
  now?: () => number;
} = {}): UsageLedger {
  const entries: UsageEntry[] = loadPersistedEntries(storagePath, maxEntries, now);
  const pending = new Map<
    string,
    {
      requestId: string;
      startedMs: number;
      startedAt: string;
      model: UsageModel;
      costRates: CostRates | null;
    }
  >();
  const listeners = new Set<UsageEntryListener>();
  let sequence = 0;
  // Debounced persistence state: one pending rewrite serves any number of
  // appends landed since the last flush.
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const nextRequestId = () => {
    sequence += 1;
    return `llm_${now().toString(36)}_${sequence.toString(36)}`;
  };

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    persistEntries(storagePath, entries);
  };

  const scheduleFlush = (): void => {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  };

  const append = (entry: UsageEntry): UsageEntry => {
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
    if (storagePath) scheduleFlush();
    emit(listeners, entry);
    return entry;
  };

  return {
    start(meta: UsageLedgerStartMeta = {}) {
      const requestId = nextRequestId();
      const startedMs = now();
      const startedAt = toIso(startedMs);
      pending.set(requestId, {
        requestId,
        startedMs,
        startedAt,
        model: normalizeModel(meta.model),
        costRates: meta.costRates ?? null,
      });
      return { requestId, startedAt };
    },

    finish(requestId: string, result: UsageLedgerResult = {}) {
      const pendingEntry = pending.get(requestId);
      if (!pendingEntry) return null;
      pending.delete(requestId);
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: result.costRates ?? pendingEntry.costRates,
      });
      return append({
        requestId,
        startedAt: pendingEntry.startedAt,
        endedAt: toIso(endedMs),
        durationMs: Math.max(0, endedMs - pendingEntry.startedMs),
        status: usage ? "ok" : "usage_missing",
        model: normalizeModel(result.model ?? pendingEntry.model),
        usage,
        error: null,
      });
    },

    recordError(requestId, error, status, result = {}) {
      const pendingEntry = pending.get(requestId);
      if (!pendingEntry) return null;
      pending.delete(requestId);
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: result.costRates ?? pendingEntry.costRates,
      });
      return append({
        requestId,
        startedAt: pendingEntry.startedAt,
        endedAt: toIso(endedMs),
        durationMs: Math.max(0, endedMs - pendingEntry.startedMs),
        status,
        model: normalizeModel(result.model ?? pendingEntry.model),
        usage,
        error: normalizeError(error),
      });
    },

    list(filter: UsageListFilter = {}) {
      const limit = normalizeLimit(filter.limit);
      const filtered = entries.filter((entry) => matchesFilter(entry, filter));
      return (limit ? filtered.slice(Math.max(0, filtered.length - limit)) : filtered).map(clone);
    },

    subscribe(listener: UsageEntryListener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    clear() {
      entries.length = 0;
      pending.clear();
      // A wipe must be durable the moment the user sees the empty panel —
      // no debounce window in which an old ledger could resurrect.
      dirty = true;
      flush();
    },

    flush,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadPersistedEntries(
  storagePath: string | null,
  maxEntries: number,
  now: () => number,
): UsageEntry[] {
  if (!storagePath) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
    const rawEntries = Array.isArray(raw?.entries) ? raw.entries : [];
    return rawEntries
      .map((entry: unknown) => normalizeEntry(entry, now))
      .filter((entry: UsageEntry) => entry.requestId)
      .slice(-maxEntries);
  } catch (err) {
    // ENOENT on first run is expected — anything else we swallow rather than
    // crash the app over a corrupt ledger.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return [];
  }
}

function persistEntries(storagePath: string | null, entries: UsageEntry[]): void {
  if (!storagePath) return;
  try {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    // Minified on purpose: the ledger is machine-read only, and at the 20k cap
    // pretty-printing would multiply both the file size and the stringify cost
    // of every flush.
    const payload = `${JSON.stringify({ version: STORAGE_VERSION, entries })}\n`;
    const temp = `${storagePath}.tdease-${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, payload, "utf8");
    // rename is atomic on the same volume. The main-process caller (electron/
    // main.ts) wraps this in the Windows-lock-retry helper when it owns the
    // write; here we keep the ledger self-contained for non-Electron callers
    // (tests, future CLI) by doing a plain rename and letting the caller retry
    // if it throws.
    fs.renameSync(temp, storagePath);
  } catch {
    // Usage accounting must never break the model request path.
  }
}

function normalizeEntry(entry: unknown, now: () => number): UsageEntry {
  const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : toIso(now());
  const endedAt =
    record.endedAt === null || typeof record.endedAt === "string"
      ? (record.endedAt as string | null)
      : toIso(now());
  return {
    requestId: String(record.requestId || ""),
    startedAt,
    endedAt,
    durationMs: numberOrNull(record.durationMs),
    status: normalizeStatus(record.status),
    model: normalizeModel(record.model),
    usage: (record.usage as NormalizedUsage | null) ?? null,
    error: (record.error as UsageEntry["error"]) ?? null,
  };
}

// ─── Usage normalization (subset of openhanako's usage-observer) ──────────────

function normalizeUsage(
  usage: unknown,
  options: { costRates?: CostRates | null },
): NormalizedUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, any>;

  // Canonical semantics (pi-normalized, the shape every live feeder sends):
  // `input` counts UNCACHED prompt tokens; cache read/write ride separate
  // counters, so total prompt tokens = input + cacheRead + cacheWrite. A raw
  // OpenAI-compatible payload reports prompt_tokens INCLUSIVE of cached
  // tokens — converted the same way pi-ai does (subtract the cache counters),
  // so every downstream number shares one contract.
  const cacheReadTokens = firstNumber(
    raw.cacheRead,
    raw.cacheReadTokens,
    raw.cache_read_input_tokens,
    raw.prompt_cache_hit_tokens,
    raw.prompt_tokens_details?.cached_tokens,
    raw.input_tokens_details?.cached_tokens,
  );
  const cacheWriteTokens = cacheCreationTokens(raw);
  const openAiPrompt = numberOrNull(raw.prompt_tokens);
  const inputTokens = openAiPrompt !== null
    ? Math.max(0, openAiPrompt - cacheReadTokens - cacheWriteTokens)
    : firstNumber(raw.input, raw.inputTokens, raw.input_tokens);
  const outputTokens = firstNumber(raw.output, raw.outputTokens, raw.output_tokens, raw.completion_tokens);
  const reasoning = maybeNumber(
    raw.reasoningTokens,
    raw.reasoning_tokens,
    raw.completion_tokens_details?.reasoning_tokens,
    raw.output_tokens_details?.reasoning_tokens,
  );
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  // total = prompt + output. promptTokens already contains inputTokens, so
  // re-adding input here would double-count every uncached prompt token.
  const totalTokens = firstNumber(raw.totalTokens, raw.total_tokens, promptTokens + outputTokens);

  const normalized: NormalizedUsage = {
    input: {
      totalTokens: inputTokens,
      uncachedTokens: inputTokens,
    },
    output: { totalTokens: outputTokens, reasoningTokens: reasoning },
    cache: {
      readTokens: cacheReadTokens || null,
      writeTokens: cacheWriteTokens || null,
      // Share of ALL prompt tokens served from cache — never exceeds 1, and
      // stays meaningful when the uncached share is tiny (long agent turns).
      hitRatio: promptTokens > 0 && cacheReadTokens > 0 ? cacheReadTokens / promptTokens : null,
    },
    totalTokens,
    costTotal: costTotal(raw, options.costRates, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }),
  };
  return normalized;
}

function cacheCreationTokens(usage: Record<string, any>): number {
  const direct = maybeNumber(
    usage.cacheWrite,
    usage.cacheWriteTokens,
    usage.cache_creation_input_tokens,
  );
  if (direct !== null) return direct;
  const creation = usage.cache_creation;
  if (!creation || typeof creation !== "object") return 0;
  return firstNumber(creation.ephemeral_5m_input_tokens) + firstNumber(creation.ephemeral_1h_input_tokens);
}

function costTotal(
  usage: Record<string, any>,
  costRates: CostRates | null | undefined,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number | null {
  const explicit = maybeNumber(usage.costTotal, usage.cost?.total);
  if (explicit !== null) return explicit;
  if (!costRates || typeof costRates !== "object") return null;
  const input = firstNumber(costRates.input) * tokens.inputTokens / 1_000_000;
  const output = firstNumber(costRates.output) * tokens.outputTokens / 1_000_000;
  const cacheRead = firstNumber(costRates.cacheRead) * tokens.cacheReadTokens / 1_000_000;
  const cacheWrite = firstNumber(costRates.cacheWrite) * tokens.cacheWriteTokens / 1_000_000;
  const total = input + output + cacheRead + cacheWrite;
  return Number.isFinite(total) ? total : null;
}

// ─── Filters & helpers ────────────────────────────────────────────────────────

function matchesFilter(entry: UsageEntry, filter: UsageListFilter): boolean {
  if (filter.since && entry.endedAt && entry.endedAt < filter.since) return false;
  if (filter.until && entry.startedAt && entry.startedAt > filter.until) return false;
  if (filter.status && entry.status !== filter.status) return false;
  if (filter.provider && entry.model.provider !== filter.provider) return false;
  if (filter.modelId && entry.model.modelId !== filter.modelId) return false;
  return true;
}

function normalizeLimit(limit: unknown): number | null {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function emit(listeners: Set<UsageEntryListener>, entry: UsageEntry): void {
  for (const listener of listeners) {
    try { listener(entry); } catch { /* listener must not break accounting */ }
  }
}

function normalizeModel(model: unknown): UsageModel {
  const record = (model && typeof model === "object" ? model : {}) as Record<string, unknown>;
  return {
    provider: textOrNull(record.provider),
    modelId: textOrNull(record.modelId ?? record.id),
    api: textOrNull(record.api),
  };
}

function normalizeError(error: unknown): UsageEntry["error"] {
  if (!error) return { name: null, message: null };
  return {
    name: typeof (error as Error).name === "string" ? (error as Error).name : null,
    message:
      typeof (error as Error).message === "string"
        ? (error as Error).message
        : String(error),
  };
}

function normalizeStatus(status: unknown): UsageEntry["status"] {
  if (status === "ok" || status === "error" || status === "aborted" || status === "usage_missing") {
    return status;
  }
  return "usage_missing";
}

function clone(value: UsageEntry): UsageEntry {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return 0;
}

function maybeNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}
