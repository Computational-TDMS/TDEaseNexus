<!--
  §7.4's unifying accelerator: commands, open documents and Runs in one
  ranked list, `>` narrowing to commands and `@` to Runs, and a disabled
  command SHOWN greyed WITH its reason, because hiding it teaches nothing.

  Three implementation decisions worth stating here rather than in a review:

  1. **Native `<dialog>` + `showModal()`, not an absolutely-positioned div.**
     The shell has several overflow containers (the tab strip, the Navigator,
     every ResizableSplit pane) and a dropdown inside one gets clipped. The
     top layer is the fix the platform already ships, and it brings the focus
     trap, the inertness of everything behind it and `::backdrop` with it.
     Electron 37 is Chromium 138, so there is no fallback matrix to carry --
     the one `typeof showModal` guard below exists for a detached test mount,
     not for a browser.

  2. **The input never gives up DOM focus.** Arrow keys move
     `aria-activedescendant` over the listbox while the caret stays where the
     user is typing. That is the combobox pattern, and it is why the whole
     palette is operable without a mouse.

  3. **Esc dismisses, never destroys** (§7.5). From the argument step it
     returns to the list; from the list it closes. Neither path discards the
     query or a half-filled argument form -- `paletteStore.close()` resets the
     step and nothing else.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import Empty from '@/components/primitives/Empty.vue'
import SchemaForm, { type JSONSchemaObject } from '@/components/primitives/SchemaForm.vue'
import StatusMark, { type RunStatus as MarkStatus } from '@/components/primitives/StatusMark.vue'
import { usePaletteStore, type PaletteBlockedReason, type PaletteGroup, type PaletteItem } from '@/stores/palette'

const { t } = useI18n()
const palette = usePaletteStore()

/**
 * The slice of the dialog element this component drives. Declared rather than
 * imported because the repo's eslint browser-globals list has no
 * `HTMLDialogElement` entry, and naming the three members we use is smaller
 * (and more honest about the `showModal` guard below) than widening a global.
 */
interface DialogElement extends HTMLElement {
  open: boolean
  showModal?: () => void
  close?: () => void
}

const dialogRef = ref<DialogElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const activeIndex = ref(0)

/**
 * Arrow keys walk what the user can see, so the traversal order is the
 * *grouped* order, not the globally-ranked one the store hands back.
 */
const flatItems = computed<PaletteItem[]>(() =>
  palette.groupedResults.flatMap((group) => group.items))

const activeItem = computed<PaletteItem | null>(() => flatItems.value[activeIndex.value] ?? null)

function optionId(item: PaletteItem): string {
  return `command-palette-option-${item.key}`
}

const groupLabels: Record<PaletteGroup, string> = {
  commands: 'workbench.commandPalette.groupCommands',
  documents: 'workbench.commandPalette.groupDocuments',
  runs: 'workbench.commandPalette.groupRuns',
}

const blockedCopy: Record<PaletteBlockedReason, string> = {
  'no-workspace': 'workbench.commandPalette.blockedNoWorkspace',
  'needs-review': 'workbench.commandPalette.blockedNeedsReview',
  'no-result-surface': 'workbench.commandPalette.blockedNoResultSurface',
  'session-capability': 'workbench.commandPalette.blockedSessionCapability',
}

function toMarkStatus(status: string): MarkStatus {
  return status.toLowerCase() as MarkStatus
}

// --- The argument step (§7.3) -------------------------------------------

/**
 * The registry's `JsonSchema` and `SchemaForm`'s `JSONSchemaObject` describe
 * the same six shapes with two different declarations; every command's `args`
 * is validated at registration to be an object schema, so this narrows rather
 * than converts. Nothing is reshaped -- `SchemaForm` renders a shape it does
 * not support as a visible "unsupported" notice rather than a silent gap.
 */
const pendingSchema = computed<JSONSchemaObject | null>(() => {
  const schema = palette.pendingCommand?.command?.schema
  if (!schema) return null
  return { ...schema, type: 'object', properties: schema.properties ?? {} } as unknown as JSONSchemaObject
})

const argErrorMessages = computed<Record<string, string>>(() =>
  Object.fromEntries(Object.keys(palette.argErrors)
    .map((key) => [key, t('workbench.commandPalette.argsRequired')])))

// --- Opening, closing, focus --------------------------------------------

function syncDialog(open: boolean) {
  const dialog = dialogRef.value
  if (!dialog) return
  if (open) {
    if (dialog.open) return
    // jsdom mounts that are not attached to the document throw on
    // showModal(); the attribute fallback keeps the component testable
    // without pretending a non-modal dialog is equivalent in production.
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal()
      } catch {
        dialog.setAttribute('open', '')
      }
    } else {
      dialog.setAttribute('open', '')
    }
    void nextTick(() => inputRef.value?.focus())
    return
  }
  if (!dialog.open) return
  if (typeof dialog.close === 'function') dialog.close()
  else dialog.removeAttribute('open')
}

watch(() => palette.isOpen, (open) => { void nextTick(() => syncDialog(open)) })

// A new query is a new list: the first row is the answer the ranker chose.
watch(() => [palette.query, flatItems.value.length], () => { activeIndex.value = 0 })

/**
 * `Ctrl/Cmd+K` (§7.5). A document-level listener rather than a binding on the
 * shell, because the palette must open from anywhere -- including from inside
 * the Agent composer, which is where a user most often wants it.
 */
function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key?.toLowerCase() !== 'k') return
  if (!event.ctrlKey && !event.metaKey) return
  if (event.altKey) return
  event.preventDefault()
  palette.toggle()
}

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown)
  if (palette.isOpen) syncDialog(true)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
})

// --- Keyboard inside the palette ----------------------------------------

function move(step: 1 | -1) {
  const total = flatItems.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + step + total) % total
}

function onListKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown': event.preventDefault(); move(1); break
    case 'ArrowUp': event.preventDefault(); move(-1); break
    case 'Home': event.preventDefault(); activeIndex.value = 0; break
    case 'End': event.preventDefault(); activeIndex.value = Math.max(0, flatItems.value.length - 1); break
    case 'Enter': {
      event.preventDefault()
      const item = activeItem.value
      if (item) void palette.activate(item)
      break
    }
    default: break
  }
}

function onArgsKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void palette.submitPending()
  }
}

/**
 * `<dialog>` raises `cancel` for Esc. From the argument step we refuse the
 * close and step back to the list instead, so one Esc never throws away both
 * the form and the search at once.
 */
function onCancel(event: Event) {
  if (palette.pendingCommandId) {
    event.preventDefault()
    palette.cancelArgs()
    void nextTick(() => inputRef.value?.focus())
    return
  }
  event.preventDefault()
  palette.close()
}

/** A native close (backdrop, form method=dialog) must not leave the store open. */
function onClose() {
  if (palette.isOpen) palette.close()
}

function onSurfaceClickOutside(event: MouseEvent) {
  // The dialog element itself fills the viewport in the top layer; a click
  // that lands on it rather than on the surface is a backdrop click.
  if (event.target === dialogRef.value) palette.close()
}

function onInput(event: Event) {
  palette.setQuery((event.target as HTMLInputElement).value)
}

function onRowClick(item: PaletteItem, index: number) {
  activeIndex.value = index
  void palette.activate(item)
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="command-palette"
    :aria-label="t('workbench.commandPalette.title')"
    @cancel="onCancel"
    @close="onClose"
    @click="onSurfaceClickOutside"
  >
    <div class="command-palette__surface">
      <!-- Step 1: the list -->
      <template v-if="!palette.pendingCommandId">
        <div class="command-palette__search">
          <input
            ref="inputRef"
            class="command-palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-palette-listbox"
            :aria-activedescendant="activeItem ? optionId(activeItem) : undefined"
            :aria-label="t('workbench.commandPalette.placeholder')"
            :placeholder="t('workbench.commandPalette.placeholder')"
            :value="palette.query"
            @input="onInput"
            @keydown="onListKeydown"
          >
        </div>

        <ul
          id="command-palette-listbox"
          class="command-palette__list"
          role="listbox"
          :aria-label="t('workbench.commandPalette.title')"
        >
          <template v-for="group in palette.groupedResults" :key="group.group">
            <li class="command-palette__group text-label" role="presentation">
              {{ t(groupLabels[group.group]) }}
            </li>
            <li
              v-for="item in group.items"
              :id="optionId(item)"
              :key="item.key"
              role="option"
              class="command-palette__row"
              :class="{
                'is-active': activeItem?.key === item.key,
                'is-blocked': !!item.blocked,
              }"
              :aria-selected="activeItem?.key === item.key"
              :aria-disabled="item.blocked ? 'true' : undefined"
              @click="onRowClick(item, flatItems.indexOf(item))"
            >
              <StatusMark
                v-if="item.runStatus"
                class="command-palette__mark"
                :status="toMarkStatus(item.runStatus)"
                size="sm"
              />
              <span class="command-palette__row-main">
                <span class="command-palette__row-title">{{ item.title }}</span>
                <span class="command-palette__row-detail">{{ item.detail }}</span>
              </span>
              <span v-if="item.group === 'commands'" class="command-palette__row-id mono">{{ item.matchId }}</span>
              <!-- Single muted hint, not a two-line warning block: a blocked
                   row is documentation (§7.5), not an error the user caused.
                   The warning voice here made the default palette read as
                   broken (2026-09-05 review). -->
              <span v-if="item.blocked" class="command-palette__row-blocked text-label">
                {{ t('workbench.commandPalette.blockedLabel') }} · {{ t(blockedCopy[item.blocked]) }}
              </span>
            </li>
          </template>
        </ul>

        <Empty
          v-if="!flatItems.length"
          :title="t('workbench.commandPalette.emptyTitle')"
          :description="t('workbench.commandPalette.emptyDescription')"
        />

        <footer class="command-palette__hints">
          <span>{{ t('workbench.commandPalette.hintMove') }}</span>
          <span>{{ t('workbench.commandPalette.hintRun') }}</span>
          <span>{{ t('workbench.commandPalette.hintDismiss') }}</span>
          <span class="command-palette__hints-prefix">{{ t('workbench.commandPalette.hintPrefix') }}</span>
        </footer>
      </template>

      <!-- Step 2: arguments (§7.3). Reached only from a command that declares
           required args -- the palette never invokes one with empty args. -->
      <template v-else>
        <div class="command-palette__args" @keydown="onArgsKeydown">
          <h2 class="command-palette__args-title">
            {{ t('workbench.commandPalette.argsTitle', { command: palette.pendingCommand?.title ?? '' }) }}
          </h2>
          <p class="command-palette__args-id mono">{{ palette.pendingCommandId }}</p>

          <SchemaForm
            v-if="pendingSchema"
            :schema="pendingSchema"
            :model-value="palette.draftArgs"
            :errors="argErrorMessages"
            @update:model-value="palette.setDraftArgs($event)"
          />

          <p v-if="palette.lastError" class="command-palette__args-error" role="alert">
            {{ palette.lastError }}
          </p>

          <p class="command-palette__args-hint">{{ t('workbench.commandPalette.argsHint') }}</p>

          <div class="command-palette__args-actions">
            <AppButton variant="subtle" size="sm" @click="palette.cancelArgs()">
              {{ t('workbench.commandPalette.argsBack') }}
            </AppButton>
            <AppButton
              variant="primary"
              size="sm"
              :loading="palette.busy"
              @click="palette.submitPending()"
            >
              {{ t('workbench.commandPalette.argsRun') }}
            </AppButton>
          </div>
        </div>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.command-palette {
  /* The dialog element is the top-layer container; the visible card is
     `__surface`, so the element itself carries no chrome of its own. */
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  max-width: 100vw;
  max-height: 100vh;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--text-base);
}

.command-palette::backdrop {
  background: color-mix(in srgb, var(--color-bg-tertiary) 62%, transparent);
}

.command-palette__surface {
  display: flex;
  flex-direction: column;
  width: min(640px, 92vw);
  max-height: 64vh;
  margin: 12vh auto 0;
  overflow: hidden;
  background: var(--color-bg-card);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-3);
  /* transform/opacity only -- never width, height, padding or margin. */
  animation: command-palette-enter var(--dur-fast) var(--ease-out);
}

@keyframes command-palette-enter {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .command-palette__surface { animation: none; }
}

.command-palette__search {
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-seam);
}

.command-palette__input {
  width: 100%;
  height: var(--row-h);
  padding: 0 var(--space-1);
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-md);
  line-height: var(--text-md-lh);
}

.command-palette__input::placeholder {
  color: var(--color-text-disabled);
}

.command-palette__input:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.command-palette__list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: var(--space-1) 0;
  list-style: none;
  overflow-y: auto;
}

.command-palette__group {
  padding: var(--space-2) var(--space-3) var(--space-1);
  color: var(--color-text-disabled);
}

.command-palette__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  min-height: var(--row-h);
  cursor: pointer;
  /* No side stripe: the active row is a background plus a stronger label. */
  background: transparent;
  transition: background-color var(--dur-instant) var(--ease-out);
}

.command-palette__row:hover {
  background: var(--color-bg-muted);
}

.command-palette__row.is-active {
  background: var(--color-primary-soft);
}

.command-palette__row.is-active .command-palette__row-title {
  color: var(--color-text);
  font-weight: 600;
}

.command-palette__row.is-blocked {
  cursor: default;
  color: var(--color-text-disabled);
}

.command-palette__row.is-blocked .command-palette__row-title,
.command-palette__row.is-blocked .command-palette__row-detail {
  color: var(--color-text-disabled);
}

.command-palette__mark {
  flex: none;
  align-self: center;
}

.command-palette__row-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}

.command-palette__row-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.command-palette__row-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.command-palette__row-id {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  line-height: var(--text-mono-lh);
  color: var(--color-text-disabled);
}

.command-palette__row-blocked {
  flex: 1 1 100%;
  order: 9;
  color: var(--color-text-muted);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.command-palette__hints {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-top: var(--line-w) solid var(--line-seam);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-disabled);
}

.command-palette__hints-prefix {
  margin-left: auto;
}

.command-palette__args {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  overflow-y: auto;
}

.command-palette__args-title {
  margin: 0;
  font-size: var(--text-md);
  line-height: var(--text-md-lh);
  font-weight: 600;
}

.command-palette__args-id {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  line-height: var(--text-mono-lh);
  color: var(--color-text-disabled);
}

.command-palette__args-error {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-error-text);
}

.command-palette__args-hint {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-disabled);
}

.command-palette__args-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
