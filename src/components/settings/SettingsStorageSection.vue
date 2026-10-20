<script setup lang="ts">
// 存储与日志分区：缓存上限、存储管理入口、日志落盘与级别。
// Storage and logging section: cache cap, storage manager entry, log file and level.
//
// 折叠状态由 SettingsView 统一持久化，这里通过 props/emit 与父层同步。
// Expanded state is persisted by SettingsView; this section syncs via props/emit.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import EditableRangeValue from '@/components/ui/EditableRangeValue.vue'
import {
  MAX_MEDIA_CACHE_SIZE_MB,
  MIN_MEDIA_CACHE_SIZE_MB,
  useSettingsStore,
} from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { useExpandTransition } from '@/composables/useExpandTransition'
import { createLogger } from '@/utils/logger'

const props = defineProps<{ expanded: boolean }>()
const emit = defineEmits<{ toggle: []; openStorage: [] }>()

const { t } = useI18n()
const settings = useSettingsStore()
const { maxCacheSize, logToFile, logLevel } = storeToRefs(settings)
const toast = useToastStore()
const log = createLogger('settings-view')
const { onExpandEnter, onExpandAfterEnter, onExpandLeave, onExpandAfterLeave } = useExpandTransition()

const logLevelOptions = computed<Array<{ value: string; label: string }>>(() => [
  { value: 'off', label: t('settings.log_level_off') },
  { value: 'error', label: t('settings.log_level_error') },
  { value: 'warn', label: t('settings.log_level_warn') },
  { value: 'info', label: t('settings.log_level_info') },
  { value: 'debug', label: t('settings.log_level_debug') },
  { value: 'trace', label: t('settings.log_level_trace') },
])

function onLogToFileChange() {
  toast.show(t('settings.log_to_file_restart_hint'), 'info')
}

async function openLogDir() {
  try {
    const dir = await invoke<string>('get_log_dir')
    // 走后端 reveal_in_file_manager，避免依赖 opener:allow-reveal-item-in-dir 权限。
    // Use the backend reveal command; the opener capability only allows opening URLs.
    await invoke('reveal_in_file_manager', { path: dir })
  } catch (error) {
    log.error('failed to open log dir:', error)
    toast.error(t('settings.open_log_dir_failed'))
  }
}
</script>

<template>
        <div class="settings-section-panel" data-section="storage">
    <div class="section-label clickable" @click="emit('toggle')">
      <span class="material-symbols-rounded" style="font-size: 18px">folder</span>
      <span>{{ t('settings.storage') }}</span>
      <span class="material-symbols-rounded section-arrow" :class="{ expanded: props.expanded }">expand_more</span>
    </div>

    <Transition @enter="onExpandEnter" @after-enter="onExpandAfterEnter" @leave="onExpandLeave" @after-leave="onExpandAfterLeave"><div v-if="props.expanded">
      <div class="setting-card">
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">sd_storage</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.cache_limit') }}</div>
          <EditableRangeValue
            v-model="maxCacheSize"
            class="setting-desc"
            :min="MIN_MEDIA_CACHE_SIZE_MB"
            :max="MAX_MEDIA_CACHE_SIZE_MB"
            :step="256"
            :display-value="maxCacheSize >= 1024 ? `${(maxCacheSize / 1024).toFixed(1)} GB` : `${maxCacheSize} MB`"
            input-suffix="MB"
            :aria-label="t('settings.cache_limit')"
          />
        </div>
        <input
          v-model.number="maxCacheSize"
          type="range"
          class="m3-slider"
          :min="MIN_MEDIA_CACHE_SIZE_MB"
          :max="MAX_MEDIA_CACHE_SIZE_MB"
          step="256"
        />
      </div>

      <div class="setting-card" style="cursor: pointer" @click="emit('openStorage')">
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">database</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.storage_usage_title') }}</div>
          <div class="setting-desc">{{ t('settings.storage_usage_desc') }}</div>
        </div>
        <span class="material-symbols-rounded" style="font-size: 20px; opacity: 0.3">chevron_right</span>
      </div>

      <div class="section-label" style="margin-top: 8px">
        <span class="material-symbols-rounded" style="font-size: 18px">description</span>
        <span>{{ t('settings.logs_title') }}</span>
      </div>

      <div class="setting-card">
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">edit_note</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.log_to_file') }}</div>
          <div class="setting-desc">{{ t('settings.log_to_file_desc') }}</div>
        </div>
        <label class="m3-switch"><input type="checkbox" v-model="logToFile" @change="onLogToFileChange" /><span class="track"><span class="thumb"><span v-if="logToFile" class="material-symbols-rounded" style="font-size: 14px">check</span></span></span></label>
      </div>

      <div class="setting-card">
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">tune</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.log_level') }}</div>
          <div class="setting-desc">{{ t('settings.log_level_desc') }}</div>
          <div class="chip-row" style="margin-top: 8px">
            <button v-for="opt in logLevelOptions" :key="opt.value" class="m3-chip sm" :class="{ active: logLevel === opt.value }" @click="logLevel = opt.value">{{ opt.label }}</button>
          </div>
        </div>
      </div>

      <div class="setting-card" style="cursor: pointer" @click="openLogDir">
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">folder_open</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.open_log_dir') }}</div>
          <div class="setting-desc">{{ t('settings.open_log_dir_desc') }}</div>
        </div>
        <span class="material-symbols-rounded" style="font-size: 20px; opacity: 0.3">chevron_right</span>
      </div>
    </div></Transition>
        </div>
</template>

<style scoped lang="scss">
@use '../../styles/settings-common' as *;
</style>
