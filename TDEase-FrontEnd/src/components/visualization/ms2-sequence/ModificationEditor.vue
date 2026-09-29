<template>
  <div class="modification-editor">
    <div class="editor-header">
      <span class="editor-title">{{ t('visualization.ms2.modifications', { count: mods.length }) }}</span>
      <AppButton size="sm" variant="primary" @click="showAddDialog = true">
        <template #icon><el-icon><Plus /></el-icon></template>
        {{ t('visualization.ms2.add') }}
      </AppButton>
    </div>

    <div class="mod-list">
      <div v-if="mods.length === 0" class="empty-state">
        {{ t('visualization.ms2.noModifications') }}
      </div>
      <div
        v-for="mod in mods"
        :key="mod.id"
        class="mod-item"
        :class="{ highlighted: selectedMod?.id === mod.id }"
        @click="selectMod(mod)"
      >
        <div class="mod-info">
          <span class="mod-name">{{ mod.name }}</span>
          <span class="mod-position">{{ t('visualization.ms2.positionLabel', { position: mod.position }) }}{{ mod.positionEnd ? `-${mod.positionEnd}` : '' }}</span>
          <span class="mod-mass" :class="mod.massShift >= 0 ? 'positive' : 'negative'">
            {{ mod.massShift >= 0 ? '+' : '' }}{{ mod.massShift.toFixed(4) }} Da
          </span>
        </div>
        <div class="mod-actions">
          <IconButton
            size="sm"
            :aria-label="t('visualization.ms2.editModification')"
            :title="t('visualization.ms2.editModification')"
            @click.stop="editMod(mod)"
          >
            <Edit />
          </IconButton>
          <IconButton
            size="sm"
            class="mod-delete"
            :aria-label="t('common.button.delete')"
            :title="t('common.button.delete')"
            @click.stop="deleteMod(mod.id)"
          >
            <Delete />
          </IconButton>
        </div>
      </div>
    </div>

    <!-- Add/Edit Dialog -->
    <el-dialog
      v-model="showAddDialog"
      :title="isEditing ? t('visualization.ms2.editModification') : t('visualization.ms2.addModification')"
      width="400px"
      @close="resetForm"
    >
      <el-form :model="form" label-width="100px">
        <el-form-item :label="t('visualization.ms2.fieldName')">
          <el-input v-model="form.name" :placeholder="t('visualization.ms2.fieldNamePlaceholder')" />
        </el-form-item>

        <el-form-item :label="t('visualization.ms2.fieldType')">
          <el-select v-model="form.type" :placeholder="t('visualization.ms2.selectType')">
            <el-option :label="t('visualization.ms2.modType.ptm')" value="ptm" />
            <el-option :label="t('visualization.ms2.modType.massShift')" value="massShift" />
            <el-option :label="t('visualization.ms2.modType.label')" value="label" />
          </el-select>
        </el-form-item>

        <el-form-item :label="t('visualization.ms2.fieldPosition')">
          <div class="position-inputs">
            <el-input-number v-model="form.position" :min="1" :max="sequenceLength" />
            <span class="position-separator">{{ t('visualization.ms2.to') }}</span>
            <el-input-number v-model="form.positionEnd" :min="form.position" :max="sequenceLength" :placeholder="t('visualization.ms2.optional')" />
          </div>
        </el-form-item>

        <el-form-item :label="t('visualization.ms2.fieldMassShift')">
          <el-input-number
            v-model="form.massShift"
            :precision="4"
            :step="0.01"
            style="width: 100%"
          />
          <div class="quick-shifts">
            <AppButton
              v-for="shift in QUICK_SHIFTS"
              :key="shift.name"
              size="sm"
              variant="subtle"
              @click="applyQuickShift(shift)"
            >
              {{ shift.name }}
            </AppButton>
          </div>
        </el-form-item>

        <el-form-item :label="t('visualization.ms2.fieldComposition')">
          <el-input v-model="form.composition" :placeholder="t('visualization.ms2.fieldCompositionPlaceholder')" />
        </el-form-item>

        <el-form-item :label="t('visualization.ms2.fieldUnimodId')">
          <el-input v-model="form.unimodId" :placeholder="t('visualization.ms2.fieldUnimodIdPlaceholder')" />
        </el-form-item>
      </el-form>

      <template #footer>
        <AppButton size="sm" @click="showAddDialog = false">{{ t('common.button.cancel') }}</AppButton>
        <AppButton size="sm" variant="primary" @click="saveMod">
          {{ isEditing ? t('common.button.save') : t('visualization.ms2.add') }}
        </AppButton>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Edit, Delete } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import IconButton from '@/components/primitives/IconButton.vue'
import type { Modification } from '@/composables/ms2-sequence/fragmentation'

const { t } = useI18n()

interface Props {
  modifications: Modification[]
  sequenceLength: number
}

const props = defineProps<Props>()

const emit = defineEmits<{
  add: [mod: Omit<Modification, 'id'>]
  update: [id: string, mod: Partial<Modification>]
  delete: [id: string]
  select: [mod: Modification | null]
}>()

// Common mass shifts for quick selection
const QUICK_SHIFTS = [
  { name: 'Carbamidomethyl', massShift: 57.02146 },
  { name: 'Oxidation', massShift: 15.99491 },
  { name: 'Phospho', massShift: 79.96633 },
  { name: 'Acetyl', massShift: 42.01056 },
  { name: 'Methyl', massShift: 14.01565 },
  { name: 'Deamidated', massShift: 0.98402 },
  { name: 'GlyGly', massShift: 114.04293 },
  { name: 'Pyro-glu', massShift: -17.02655 },
]

const showAddDialog = ref(false)
const isEditing = ref(false)
const editingId = ref('')
const selectedMod = ref<Modification | null>(null)

const mods = computed(() => props.modifications)

const form = reactive({
  name: '',
  type: 'ptm' as Modification['type'],
  position: 1,
  positionEnd: undefined as number | undefined,
  massShift: 0,
  composition: '',
  unimodId: ''
})

function resetForm() {
  form.name = ''
  form.type = 'ptm'
  form.position = 1
  form.positionEnd = undefined
  form.massShift = 0
  form.composition = ''
  form.unimodId = ''
  isEditing.value = false
  editingId.value = ''
}

function applyQuickShift(shift: { name: string; massShift: number }) {
  form.name = shift.name
  form.massShift = shift.massShift
}

function editMod(mod: Modification) {
  isEditing.value = true
  editingId.value = mod.id
  form.name = mod.name
  form.type = mod.type
  form.position = mod.position
  form.positionEnd = mod.positionEnd
  form.massShift = mod.massShift
  form.composition = mod.composition || ''
  form.unimodId = mod.unimodId || ''
  showAddDialog.value = true
}

function saveMod() {
  const modData: Omit<Modification, 'id'> = {
    name: form.name || t('common.button.unnamed'),
    type: form.type,
    position: form.position,
    positionEnd: form.positionEnd,
    massShift: form.massShift,
    composition: form.composition || undefined,
    unimodId: form.unimodId || undefined
  }

  if (isEditing.value) {
    emit('update', editingId.value, modData)
  } else {
    emit('add', modData)
  }

  showAddDialog.value = false
  resetForm()
}

function deleteMod(id: string) {
  emit('delete', id)
  if (selectedMod.value?.id === id) {
    selectedMod.value = null
    emit('select', null)
  }
}

function selectMod(mod: Modification) {
  selectedMod.value = mod
  emit('select', mod)
}
</script>

<style scoped>
.modification-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.editor-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--color-text);
}

.mod-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  max-height: 200px;
  overflow-y: auto;
}

.empty-state {
  text-align: center;
  color: var(--color-text-disabled);
  font-size: var(--text-sm);
  padding: var(--space-4);
}

.mod-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.mod-item:hover {
  background: var(--color-hover);
}

.mod-item.highlighted {
  background: var(--color-warning-soft);
  border: 1px solid var(--color-warning);
}

.mod-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mod-name {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
}

.mod-position {
  font-size: var(--text-label);
  color: var(--color-text-secondary);
}

.mod-mass {
  font-size: var(--text-label);
  font-weight: 600;
  font-family: var(--font-mono);
}

.mod-mass.positive {
  color: var(--color-success-text);
}

.mod-mass.negative {
  color: var(--color-error-text);
}

.mod-actions {
  display: flex;
  gap: var(--space-1);
}

/* Keeps the old type="danger" affordance on the icon-only delete action. */
.mod-delete:hover:not(:disabled) {
  color: var(--color-error-text);
}

.position-inputs {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.position-separator {
  color: var(--color-text-disabled);
  font-size: var(--text-sm);
}

.quick-shifts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
</style>
