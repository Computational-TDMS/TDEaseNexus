<template>
  <div ref="wrapperRef" class="slash-input-wrapper">
    <!-- Slash autocomplete popup -->
    <CompletionPopup
      v-if="showPopup"
      v-model:active-index="selectedIdx"
      :items="slashItems"
      :hint="t('agent.completion.hint')"
      @select="onSlashItemSelect"
    />

    <!-- @-mention picker popup (run/file) -->
    <CompletionPopup
      v-if="showMentionPopup"
      v-model:active-index="mentionSelectedIdx"
      :items="mentionItems"
      :hint="t('agent.completion.hint')"
      badge-prefix="@"
      @select="onMentionItemSelect"
    />

    <!-- $-skill picker popup -->
    <CompletionPopup
      v-if="showSkillPopup"
      v-model:active-index="skillSelectedIdx"
      :items="skillItems"
      :hint="t('agent.completion.hint')"
      badge-prefix="$"
      @select="onSkillItemSelect"
    />

    <!-- Textarea. No trigger badge is drawn while typing: the trigger
         character is already IN the textarea text, and painting a second
         decorated glyph over it produced the double-slash ghost. The only
         decoration is the mirror underlay, which re-renders CONFIRMED
         mention tokens (@kind:refId) as inline accent text — kind icon +
         short name, no box — an in-progress fragment (@ru, $sk) never
         matches the token grammar, so typing stays plain until Tab/Enter
         confirms. A `/` command needs no decoration at all: once typed it
         already IS the command. -->
    <div class="input-area">
      <div ref="mirrorRef" class="slash-mirror" aria-hidden="true"><template v-for="(segment, i) in mirrorSegments" :key="i"><span v-if="segment.token" class="mention-token"><span class="mention-token__face"><component :is="kindIcons[segment.kind]" :size="13" :stroke-width="2" /><span class="mention-token__label">{{ segment.label }}</span></span><span class="mention-token__ghost">{{ segment.text }}</span></span><template v-else>{{ segment.text }}</template></template></div>
      <textarea
        ref="textareaRef"
        :value="modelValue"
        class="slash-textarea"
        :placeholder="placeholder"
        :aria-label="placeholder"
        rows="2"
        @input="onInput"
        @keydown="onKeydown"
        @blur="onBlur"
        @scroll="syncMirrorScroll"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, FileText, Wand2 } from '@lucide/vue'
import { insertMentionToken, MENTION_REGEX, mentionFragmentAtCaret, skillFragmentAtCaret, type MentionKind } from '@/agent/mention'
import { slashCommandRowLabel } from '@/agent/slash/slash-registry'
import type { SlashCommand } from '@/types'
import CompletionPopup, { type CompletionItem } from './CompletionPopup.vue'
import { useMentionCandidates, rankCandidates, type MentionCandidate } from './useMentionCandidates'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  /** The one canonical command list, built by slash-registry in AgentPage. */
  commands: SlashCommand[]
  /**
   * Live Pi-session skills, fed into the `$`-skill picker. Optional — runs
   * and files populate the `@` picker without it.
   */
  skills?: ReadonlyArray<{ name: string; description?: string }>
  /** Enabled servers from local System + Workspace settings.json files. */
  mcpServers?: ReadonlyArray<string>
}>(), {
  modelValue: '',
  placeholder: '',
  skills: () => [],
  mcpServers: () => [],
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'send': [value: string]
  'slash': [command: string, args: string]
}>()

// ── State ──
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const wrapperRef = ref<HTMLDivElement | null>(null)
const showPopup = ref(false)
const selectedIdx = ref(0)

// @-mention state
const showMentionPopup = ref(false)
const mentionSelectedIdx = ref(0)
const mentionQuery = ref('')
// The fragment range to replace on confirm; captured from the caret on each input.
let mentionFragment: { start: number; end: number } | null = null

// $-skill picker state — parallel to the @-mention state but keyed on `$`.
const showSkillPopup = ref(false)
const skillSelectedIdx = ref(0)
const skillQuery = ref('')
let skillFragment: { start: number; end: number } | null = null

// skills is a reactive prop; wrap so useMentionCandidates can read updates.
const skillsRef = computed(() => props.skills)
const { candidates } = useMentionCandidates(skillsRef)

// ── Computed ──
const inputText = computed(() => props.modelValue)

// ── Token mirror ──
// The mirror sits ABOVE the textarea and owns only the CONFIRMED mention
// tokens: each renders as inline accent text (kind icon + short label) on an
// invisible background patch that covers the raw @kind:refId glyphs beneath,
// while a visibility-hidden copy of the raw text keeps the inline width
// exact — the caret and everything after the token stay aligned. An
// in-progress trigger fragment (@ru, $sk) never matches MENTION_REGEX (it
// requires kind + colon), so typing renders as plain text — no ghost.
type MirrorSegment =
  | { text: string; token?: false; kind?: undefined; label?: undefined }
  | { text: string; token: true; kind: MentionKind; label: string }

const kindIcons = { run: Play, file: FileText, skill: Wand2 }

function shortLabel(kind: MentionKind, refId: string): string {
  // `system:`/`workspace:` scope halves are plumbing, not vocabulary — the
  // token shows the name the user picked (and file paths show the basename).
  const label = kind === 'file' ? refId.split(/[/]/).pop() ?? refId : refId.includes(':') ? refId.slice(refId.indexOf(':') + 1) : refId
  return label.length > 24 ? `${label.slice(0, 21)}…` : label
}

const mirrorSegments = computed<MirrorSegment[]>(() => {
  const text = props.modelValue
  if (!text || !text.includes('@')) return [{ text }]
  MENTION_REGEX.lastIndex = 0
  const segments: MirrorSegment[] = []
  let last = 0
  for (const match of text.matchAll(MENTION_REGEX)) {
    const start = match.index ?? 0
    if (start > last) segments.push({ text: text.slice(last, start) })
    const kind = (match[1] === 'skill' ? match[1] : match[3]) as MentionKind
    const refId = match[2] !== undefined ? `${match[1]}:${match[2]}` : (match[4] ?? '')
    segments.push({ text: match[0], token: true, kind, label: shortLabel(kind, refId) })
    last = start + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
})

const mirrorRef = ref<HTMLDivElement | null>(null)

function syncMirrorScroll() {
  const mirror = mirrorRef.value
  const el = textareaRef.value
  if (mirror && el) mirror.scrollTop = el.scrollTop
}

/**
 * The mirror's box metrics are MEASURED from the textarea, never declared:
 * other stylesheets win specificity games against the mirror's padding (a
 * global textarea rule shrank the textarea's padding to 4px while the mirror
 * kept 8px/12px — an 8px horizontal text-origin drift, the ghost/misalignment
 * class in its purest form). Computed values are copied verbatim, so whatever
 * cascade does to the textarea, the mirror follows.
 */
function syncMirrorMetrics() {
  const el = textareaRef.value
  const mirror = mirrorRef.value
  if (!el || !mirror) return
  const computedStyle = getComputedStyle(el)
  mirror.style.padding = computedStyle.padding
  mirror.style.font = computedStyle.font
  mirror.style.letterSpacing = computedStyle.letterSpacing
  mirror.style.lineHeight = computedStyle.lineHeight
  mirror.style.inset = [
    computedStyle.borderTopWidth, computedStyle.borderRightWidth,
    computedStyle.borderBottomWidth, computedStyle.borderLeftWidth,
  ].join(' ')
}

function isSlashQuery(value: string): boolean {
  if (!value.startsWith('/') || value.includes('\n')) return false
  // A resource argument (`/mcp <partial>`) keeps the completion open across
  // the first space; any other space ends the query. Skills are bound through
  // the `$` picker, not a slash command.
  return !value.includes(' ') || /^\/mcp\s+\S*$/.test(value)
}

const isSlashActive = computed(() => isSlashQuery(inputText.value))

/**
 * One completion row. `command` rows come from the registry list; `mcp` rows
 * are the second-stage resource argument completion. Skills are bound through
 * the `$` picker, not here.
 */
type SlashRow =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'mcp'; name: string }

const rows = computed<SlashRow[]>(() => {
  if (!isSlashActive.value) return []
  const resource = inputText.value.match(/^\/mcp\s+(.*)$/)
  if (resource) {
    const query = resource[1].toLowerCase()
    return props.mcpServers
      .filter((name) => name.toLowerCase().includes(query))
      .map((name): SlashRow => ({ kind: 'mcp', name }))
  }
  const query = inputText.value.slice(1).toLowerCase()
  const commands = !query
    ? props.commands
    : props.commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(query) ||
        cmd.aliases?.some((a) => a.toLowerCase().includes(query)) ||
        cmd.description?.toLowerCase().includes(query),
    )
  return commands.map((command): SlashRow => ({ kind: 'command', command }))
})

function rowKey(row: SlashRow): string {
  switch (row.kind) {
  case 'command': return `command:${row.command.name}`
  case 'mcp': return `mcp:${row.name}`
  }
}

const slashItems = computed<CompletionItem[]>(() => rows.value.map((row) => {
  switch (row.kind) {
  case 'command': {
    return {
      key: rowKey(row),
      kind: 'command',
      badge: `/${row.command.name}`,
      // Argument hint / aliases only — the badge already carries the command,
      // and the old bare-name fallback rendered it twice (`/compact compact`).
      label: slashCommandRowLabel(row.command),
      detail: row.command.description || '',
      group: t('agent.completion.group.commands'),
    }
  }
  case 'mcp':
    return {
      key: rowKey(row),
      kind: 'mcp',
      badge: '/mcp',
      label: row.name,
      detail: t('agent.slash.localMcpServer', { name: row.name }),
      group: t('agent.completion.group.mcpServers'),
    }
  }
}))

const rowByKey = computed(() => new Map(rows.value.map((row) => [rowKey(row), row])))

// Ranking is debounced, the popup is not: `showMentionPopup` and the caret
// fragment update synchronously on every keystroke; only rankCandidates —
// three subsequence passes over every workspace file — waits 120ms for typing
// to pause. The empty query short-circuits because it is the unscored full
// list, so opening the picker paints its baseline on the very keystroke.
const MENTION_RANK_DEBOUNCE_MS = 120
const rankedMentionQuery = ref('')
let mentionRankTimer: ReturnType<typeof setTimeout> | undefined
watch(mentionQuery, (query) => {
  if (mentionRankTimer) { clearTimeout(mentionRankTimer); mentionRankTimer = undefined }
  if (!query.trim()) {
    rankedMentionQuery.value = query
    return
  }
  mentionRankTimer = setTimeout(() => {
    rankedMentionQuery.value = query
    mentionRankTimer = undefined
  }, MENTION_RANK_DEBOUNCE_MS)
})

const rankedMentions = computed(() => {
  if (!showMentionPopup.value) return []
  return rankCandidates(candidates.value, rankedMentionQuery.value)
})

const mentionKindGroup: Record<string, string> = {
  run: 'agent.completion.group.runs',
  file: 'agent.completion.group.files',
}

const mentionItems = computed<CompletionItem[]>(() =>
  rankedMentions.value.map((cand) => ({
    key: `${cand.token.kind}:${cand.token.refId}`,
    kind: cand.kind,
    label: cand.label,
    detail: cand.detail,
    group: t(mentionKindGroup[cand.kind] ?? cand.kind),
  })),
)

// ── $-skill picker ──
// Skills live behind their own `$` trigger. Ranked subsequence-style against
// the live `skills` prop, the same way the `@` picker ranks its candidates.
const rankedSkills = computed(() => {
  if (!showSkillPopup.value) return [] as Array<{ skill: { name: string; description?: string }; score: number }>
  const query = skillQuery.value.trim().toLowerCase()
  const scored: Array<{ skill: { name: string; description?: string }; score: number }> = []
  for (const skill of props.skills) {
    const byName = scoreSubsequence(query, skill.name.toLowerCase())
    const byDesc = skill.description ? scoreSubsequence(query, skill.description.toLowerCase()) : null
    const best = Math.max(byName ?? -1, byDesc ?? -1)
    if (best >= 0) scored.push({ skill, score: best })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
})

const skillItems = computed<CompletionItem[]>(() =>
  rankedSkills.value.map(({ skill }) => ({
    key: `skill:${skill.name}`,
    kind: 'skill' as const,
    label: skill.name,
    detail: skill.description || '',
    group: t('agent.completion.group.skills'),
  })),
)

/** Subsequence scorer mirroring rankCandidates' scoreCandidate (case-folded). */
function scoreSubsequence(query: string, target: string): number | null {
  if (!query) return 0
  let qi = 0
  let score = 0
  let consecutive = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti += 1) {
    if (target[ti] === query[qi]) {
      qi += 1
      consecutive += 1
      score += consecutive
    } else {
      consecutive = 0
    }
  }
  return qi === query.length ? score : null
}

// ── Watch for popup changes ──
watch(rows, () => {
  selectedIdx.value = 0
})

watch(inputText, (value) => {
  if (!isSlashQuery(value)) showPopup.value = false
})

// Autosize: collapse then re-grow to scrollHeight, capped so long drafts
// scroll internally instead of pushing the toolbar down forever. Port of
// openhanako's quick-chat manual autosize — no library, measures on every
// input via the modelValue watch (post-flush so the DOM has the new text).
watch(inputText, () => {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  syncMirrorMetrics()
  syncMirrorScroll()
}, { flush: 'post' })

watch(rankedMentions, () => {
  mentionSelectedIdx.value = 0
})

watch(rankedSkills, () => {
  skillSelectedIdx.value = 0
})

// ── Methods ──
function onInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
  showPopup.value = isSlashQuery(target.value)
  selectedIdx.value = 0
  const caret = target.selectionStart ?? target.value.length
  refreshMentionState(target.value, caret)
  refreshSkillState(target.value, caret)
}

/** Insert text at the caret (used by the Composer's image-attachment chips). */
function insertText(text: string): void {
  const el = textareaRef.value
  if (!el) return
  const start = el.selectionStart ?? props.modelValue.length
  const end = el.selectionEnd ?? start
  const next = props.modelValue.slice(0, start) + text + props.modelValue.slice(end)
  emit('update:modelValue', next)
  nextTick(() => {
    const caret = start + text.length
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

/** Strip every occurrence of a marker from the text (chip removal). */
function removeText(marker: string): void {
  if (!marker) return
  const next = props.modelValue.split(marker).join('')
  if (next !== props.modelValue) emit('update:modelValue', next)
}

/** Re-evaluate whether the caret sits inside an @-mention fragment. */
function refreshMentionState(text: string, caret: number): void {
  // `/`, `$`, and `@` are mutually exclusive triggers; `/` wins at line start,
  // and `$` owns the skill picker so it pre-empts `@`.
  if (isSlashQuery(text) || skillFragmentAtCaret(text, caret)) {
    showMentionPopup.value = false
    mentionFragment = null
    return
  }
  const fragment = mentionFragmentAtCaret(text, caret)
  if (fragment) {
    mentionFragment = { start: fragment.start, end: fragment.end }
    mentionQuery.value = fragment.query
    showMentionPopup.value = true
  } else {
    mentionFragment = null
    showMentionPopup.value = false
  }
}

/** Re-evaluate whether the caret sits inside a $-skill fragment. */
function refreshSkillState(text: string, caret: number): void {
  // Same mutual-exclusion as the `@` picker: `/` wins at line start, and `@`
  // owns run/file so it pre-empts `$`.
  if (isSlashQuery(text) || mentionFragmentAtCaret(text, caret)) {
    showSkillPopup.value = false
    skillFragment = null
    return
  }
  const fragment = skillFragmentAtCaret(text, caret)
  if (fragment) {
    skillFragment = { start: fragment.start, end: fragment.end }
    skillQuery.value = fragment.query
    showSkillPopup.value = true
  } else {
    skillFragment = null
    showSkillPopup.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  // @-mention popup navigation (takes precedence when open)
  if (showMentionPopup.value && rankedMentions.value.length) {
    switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      mentionSelectedIdx.value = (mentionSelectedIdx.value + 1) % rankedMentions.value.length
      break
    case 'ArrowUp':
      event.preventDefault()
      mentionSelectedIdx.value = (mentionSelectedIdx.value - 1 + rankedMentions.value.length) % rankedMentions.value.length
      break
    case 'Tab':
    case 'Enter':
      if (!event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        selectMention(rankedMentions.value[mentionSelectedIdx.value])
      }
      break
    case 'Escape':
      event.preventDefault()
      showMentionPopup.value = false
      break
    }
    return
  }

  // $-skill popup navigation (parallel to the @ popup)
  if (showSkillPopup.value && rankedSkills.value.length) {
    switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      skillSelectedIdx.value = (skillSelectedIdx.value + 1) % rankedSkills.value.length
      break
    case 'ArrowUp':
      event.preventDefault()
      skillSelectedIdx.value = (skillSelectedIdx.value - 1 + rankedSkills.value.length) % rankedSkills.value.length
      break
    case 'Tab':
    case 'Enter':
      if (!event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        selectSkill(rankedSkills.value[skillSelectedIdx.value].skill)
      }
      break
    case 'Escape':
      event.preventDefault()
      showSkillPopup.value = false
      break
    }
    return
  }

  if (showPopup.value && rows.value.length) {
    switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      selectedIdx.value = (selectedIdx.value + 1) % rows.value.length
      break
    case 'ArrowUp':
      event.preventDefault()
      selectedIdx.value = (selectedIdx.value - 1 + rows.value.length) % rows.value.length
      break
    case 'Tab':
    case 'Enter':
      if (!event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        selectRow(rows.value[selectedIdx.value])
      }
      break
    case 'Escape':
      event.preventDefault()
      showPopup.value = false
      break
    }
    return
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

// The blur-delay timer that defers closing the popups so a click on an item
// registers before the popup is torn down. Tracked so teardown can clear it —
// the previous inline setTimeout fired against detached refs after unmount.
let blurTimer: ReturnType<typeof setTimeout> | undefined
let mirrorMetricsObserver: ResizeObserver | null = null

function onBlur() {
  // Delay hiding so click on popup registers
  if (blurTimer) clearTimeout(blurTimer)
  blurTimer = setTimeout(() => {
    showPopup.value = false
    showMentionPopup.value = false
    showSkillPopup.value = false
    blurTimer = undefined
  }, 150)
}

onBeforeUnmount(() => {
  mirrorMetricsObserver?.disconnect()
  mirrorMetricsObserver = null
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = undefined }
  if (mentionRankTimer) { clearTimeout(mentionRankTimer); mentionRankTimer = undefined }
})

function onSlashItemSelect(item: CompletionItem) {
  const row = rowByKey.value.get(item.key)
  if (row) selectRow(row)
}

function selectRow(row: SlashRow) {
  showPopup.value = false
  textareaRef.value?.focus()
  // Completion must never execute a command. A second Enter confirms it.
  const name = row.kind === 'command' ? row.command.name : `${row.kind} ${row.name}`
  emit('update:modelValue', `/${name} `)
}

function onMentionItemSelect(item: CompletionItem) {
  const cand = rankedMentions.value.find((c) => `${c.token.kind}:${c.token.refId}` === item.key)
  if (cand) selectMention(cand)
}

function selectMention(cand: MentionCandidate) {
  showMentionPopup.value = false
  const fragment = mentionFragment
  mentionFragment = null
  if (!fragment) {
    // No tracked fragment — append at end as a fallback.
    const text = props.modelValue
    const result = insertMentionToken({ text, fragmentStart: text.length, fragmentEnd: text.length, token: cand.token })
    emit('update:modelValue', result.text)
    void restoreCaret(result.caret)
    return
  }
  const result = insertMentionToken({ text: props.modelValue, fragmentStart: fragment.start, fragmentEnd: fragment.end, token: cand.token })
  emit('update:modelValue', result.text)
  void restoreCaret(result.caret)
}

function onSkillItemSelect(item: CompletionItem) {
  const skill = rankedSkills.value.find(({ skill: s }) => `skill:${s.name}` === item.key)?.skill
  if (skill) selectSkill(skill)
}

/**
 * Confirm a `$`-picker selection: replace the in-progress `$` fragment with an
 * `@skill:<name>` mention token. The persisted token keeps the `@` grammar so
 * the parser/pipeline/replay path is untouched — `$` is purely the UI trigger.
 */
function selectSkill(skill: { name: string }) {
  showSkillPopup.value = false
  const fragment = skillFragment
  skillFragment = null
  const token = { kind: 'skill' as const, refId: skill.name }
  if (!fragment) {
    const text = props.modelValue
    const result = insertMentionToken({ text, fragmentStart: text.length, fragmentEnd: text.length, token })
    emit('update:modelValue', result.text)
    void restoreCaret(result.caret)
    return
  }
  const result = insertMentionToken({ text: props.modelValue, fragmentStart: fragment.start, fragmentEnd: fragment.end, token })
  emit('update:modelValue', result.text)
  void restoreCaret(result.caret)
}

async function restoreCaret(caret: number): Promise<void> {
  await nextTick()
  const ta = textareaRef.value
  if (!ta) return
  ta.focus()
  ta.setSelectionRange(caret, caret)
}

function submit() {
  const text = props.modelValue.trim()
  if (!text) return
  const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/)
  if (slash) {
    const typed = slash[1].toLowerCase()
    const command = props.commands.find((item) =>
      item.name.toLowerCase() === typed || item.aliases?.some((alias) => alias.toLowerCase() === typed),
    )
    if (command) {
      emit('slash', command.name, slash[2] ?? '')
      return
    }
  }
  emit('send', props.modelValue)
}

function focus() {
  textareaRef.value?.focus()
}

onMounted(() => {
  // If already has / prefix, show popup
  if (inputText.value.startsWith('/')) {
    showPopup.value = true
  }
  syncMirrorMetrics()
  if (textareaRef.value && typeof ResizeObserver !== 'undefined') {
    mirrorMetricsObserver = new ResizeObserver(syncMirrorMetrics)
    mirrorMetricsObserver.observe(textareaRef.value)
  }
  void document.fonts?.ready.then(syncMirrorMetrics)
})

defineExpose({ focus, insertText, removeText })
</script>

<style scoped>
.slash-input-wrapper {
  position: relative;
  width: 100%;
}

/* ── Input area ──
   Pure positioning wrapper — the composer card owns the surface, the
   textarea owns the border/background exactly as it always did (a nested
   second frame here read as a box-in-box). The mirror sits ABOVE the
   textarea and paints ONLY the confirmed mention chips: everything else in
   it is fully transparent, so the textarea's own glyphs remain the single
   source of visible text. */
.input-area {
  position: relative;
  display: flex;
  align-items: flex-end;
}

/* Token mirror: identical box metrics to the textarea (inset by its border),
   raw text fully transparent. A confirmed token renders as inline accent
   text (kind icon + short label) over its own width — the raw @kind:refId
   glyphs beneath are hidden by a background patch, while a visibility-hidden
   copy of the raw text keeps the inline width exact so the caret and
   following words stay aligned. */
.slash-mirror {
  position: absolute;
  inset: var(--line-w);
  z-index: var(--z-seam);
  overflow: hidden;
  pointer-events: none;
  color: transparent;
  font-family: var(--font-body, inherit);
  font-size: var(--text-base);
  line-height: 1.5;
  padding: var(--space-2) var(--space-3);
  white-space: pre-wrap;
  word-break: break-word;
}

.mention-token {
  /* Atomic inline-block: the chip's absolute box resolves against the token
     itself, and the token wraps as a unit instead of splitting mid-ghost. */
  position: relative;
  display: inline-block;
  vertical-align: baseline;
}

.mention-token__ghost {
  visibility: hidden;
}

/* The face is deliberately NOT a tag box — a confirmed token reads as colored
   inline text (kind icon + short name, the way chat clients render mentions),
   not a bordered widget. What hides the raw glyphs is the background patch:
   the exact color of the textarea's own background, hence invisible — the
   raw text simply *becomes* the accent rendering. No border, no radius. */
.mention-token__face {
  position: absolute;
  /* Overcover (2px vertical for line-box rounding, 1px horizontal for glyph
     anti-aliasing) must never let a raw glyph edge peek out — invisible
     anyway, since the patch matches the background it sits on. */
  inset: -2px -1px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--color-bg);
  color: var(--color-primary);
  white-space: nowrap;
  overflow: hidden;
}

.mention-token__face :deep(svg) {
  flex-shrink: 0;
}

.mention-token__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.slash-textarea {
  position: relative;
  z-index: var(--z-raised);
  width: 100%;
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body, inherit);
  font-size: var(--text-base);
  line-height: 1.5;
  padding: var(--space-2) var(--space-3);
  resize: none;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
  min-height: 1.6em;
  max-height: 160px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.slash-textarea:focus {
  border-color: var(--color-ring);
}

.slash-textarea::placeholder {
  color: var(--color-text-muted);
}
</style>
