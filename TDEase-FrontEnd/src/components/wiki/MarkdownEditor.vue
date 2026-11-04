<script setup lang="ts">
/**
 * MarkdownEditor — the wiki page editor, CodeMirror 6.
 *
 * The one rich editing surface in the Client (every other file document is a
 * viewer; the Agent edits through its own tools). Markdown language support
 * plus a decoration pass that marks `[[wikilinks]]` so links stay visible
 * while writing.
 *
 * The visual contract is Obsidian's editing feel, not a code editor: the
 * page is set in the app's body face at reading size (no gutters, no line
 * numbers), and every size rides the type tokens — so the user's font scale
 * (Settings → Appearance, Ctrl+=/-/0) applies here like everywhere else.
 * `save` is emitted for Ctrl/Cmd+S; the owning document decides what saving
 * means (writeWikiPage + dirty tracking live there).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'

const props = withDefaults(defineProps<{
  modelValue: string
  readOnly?: boolean
  /** Plain text (.txt page): no markdown language, no wikilink highlighting. */
  plain?: boolean
}>(), { readOnly: false, plain: false })

const emit = defineEmits<{
  'update:modelValue': [value: string]
  save: []
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

/** Mark every `[[...]]` in the visible text with the cm-wikilink class. */
const wikilinkHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = collectWikilinkDecorations(view)
  }
  update(update: import('@codemirror/view').ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = collectWikilinkDecorations(update.view)
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
})

function collectWikilinkDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const pattern = /\[\[[^\]\n]+\]\]/g
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    pattern.lastIndex = 0
    let match = pattern.exec(text)
    while (match) {
      builder.add(from + match.index, from + match.index + match[0].length, Decoration.mark({ class: 'cm-wikilink' }))
      match = pattern.exec(text)
    }
  }
  return builder.finish()
}

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-text)',
    fontSize: 'var(--text-md)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-body)',
    caretColor: 'var(--color-primary)',
    paddingBottom: '30vh',
    lineHeight: '1.7',
  },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-line': { padding: '0 12px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--color-primary) 18%, transparent) !important',
  },
  '.cm-cursor, &.cm-focused .cm-cursor': { borderLeftColor: 'var(--color-primary)' },
  '.cm-wikilink': {
    color: 'var(--color-primary)',
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    textDecorationColor: 'color-mix(in srgb, var(--color-primary) 45%, transparent)',
  },
})

function createView(): EditorView {
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true } },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      ...(props.plain ? [] : [markdown({ base: markdownLanguage, codeLanguages: [] }), wikilinkHighlighter]),
      theme,
      EditorView.editable.of(!props.readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
      }),
    ],
  })
  return new EditorView({ state, parent: host.value! })
}

onMounted(() => {
  view = createView()
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

watch(() => props.modelValue, (value) => {
  if (!view) return
  const current = view.state.doc.toString()
  if (value !== current) {
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }
})

defineExpose({
  focus: () => view?.focus(),
})
</script>

<template>
  <div ref="host" class="wiki-markdown-editor"></div>
</template>

<style scoped>
.wiki-markdown-editor {
  height: 100%;
  overflow: hidden;
}
.wiki-markdown-editor :deep(.cm-editor) {
  height: 100%;
}
</style>
