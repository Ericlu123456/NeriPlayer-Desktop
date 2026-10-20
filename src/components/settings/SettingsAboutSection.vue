<script setup lang="ts">
// 关于分区：版本信息、构建 UUID、GitHub 与 FFmpeg 入口，以及 7 连击解锁开发者模式。
// About section: version/build info, GitHub and FFmpeg links, plus the 7-tap dev unlock.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useSettingsStore } from '@/stores/settings'
import { usePlayerStore } from '@/stores/player'
import { useToastStore } from '@/stores/toast'
import { useExternalLink } from '@/composables/useExternalLink'
import { useExpandTransition } from '@/composables/useExpandTransition'
import { createLogger } from '@/utils/logger'

const props = defineProps<{ expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()
const { devModeEnabled } = storeToRefs(useSettingsStore())
const player = usePlayerStore()
const toast = useToastStore()
const log = createLogger('settings-view')
const { openExternalUrl } = useExternalLink()
const { onExpandEnter, onExpandAfterEnter, onExpandLeave, onExpandAfterLeave } = useExpandTransition()

const PROJECT_REPOSITORY_URL = 'https://github.com/cwuom/NeriPlayer-Desktop'
const FFMPEG_LEGAL_URL = 'https://ffmpeg.org/legal.html'

// 随包的 FFmpeg 是否加载成功、加载的是哪个版本；没加载上时说明哪些格式受影响。
// Whether the bundled FFmpeg loaded, and which version; the UI falls back to a hint.
const ffmpegComponentText = computed(() => {
  const capabilities = player.decoderCapabilities
  if (capabilities?.ffmpeg) return t('settings.ffmpeg_component_loaded', { version: capabilities.ffmpeg.avcodec })
  return t('settings.ffmpeg_component_unavailable')
})

// 开发者模式：7-tap 解锁 / Developer mode: unlock with seven taps.
const versionTapCount = ref(0)
let tapTimer: ReturnType<typeof setTimeout> | null = null

function handleVersionTap() {
  emit('toggle')
  if (devModeEnabled.value) return
  versionTapCount.value++
  if (tapTimer) clearTimeout(tapTimer)
  tapTimer = setTimeout(() => { versionTapCount.value = 0 }, 3000)

  const remaining = 7 - versionTapCount.value
  if (remaining <= 0) {
    devModeEnabled.value = true
    versionTapCount.value = 0
    toast.success(t('settings.dev_mode_toast'))
  } else if (remaining <= 3) {
    toast.success(t('settings.dev_mode_tap_hint', { count: remaining }))
  }
}

interface BuildInfo {
  app_version: string
  build_uuid: string
  build_timestamp: string
  version: string
}

const buildInfo = ref<BuildInfo | null>(null)

async function loadBuildInfo() {
  try {
    buildInfo.value = await invoke('get_build_info')
  } catch (e) {
    log.error('Failed to load build info:', e)
  }
}

async function copyBuildValue(value: string | undefined | null, event?: Event) {
  event?.stopPropagation()
  const text = value?.trim()
  if (!text) return
  try {
    await writeText(text)
    toast.success(t('settings.build_info_copied'))
  } catch (e) {
    log.error('Failed to copy build info:', e)
    toast.error(t('settings.build_info_copy_failed'))
  }
}

onMounted(loadBuildInfo)
onBeforeUnmount(() => {
  if (tapTimer) clearTimeout(tapTimer)
})
</script>

<template>
        <div class="settings-section-panel" data-section="about">
    <div class="section-label">
      <span class="material-symbols-rounded" style="font-size: 18px">info</span>
      <span>{{ t('settings.about') }}</span>
    </div>

    <div class="setting-card about-card" @click="handleVersionTap" style="cursor: pointer">
      <div class="setting-icon-wrap accent">
        <img src="/app-icon.png" alt="NeriPlayer" style="width: 24px; height: 24px; border-radius: 4px;" />
      </div>
      <div class="setting-info">
        <div class="setting-title about-wordmark">NeriPlayer <span class="about-wordmark-hand">Desktop</span>{{ devModeEnabled ? ' (dev)' : '' }}</div>
        <div class="setting-desc mono-build-value">
          {{ t('settings.version_info', {
            version: buildInfo?.version || 'dev',
          }) }}
        </div>
      </div>
      <button
        type="button"
        class="about-copy-btn"
        :title="t('settings.copy_build_version')"
        :aria-label="t('settings.copy_build_version')"
        @click="copyBuildValue(buildInfo?.version, $event)"
      >
        <span class="material-symbols-rounded">content_copy</span>
      </button>
      <span class="material-symbols-rounded section-arrow" :class="{ expanded: props.expanded }" style="font-size: 20px; opacity: 0.3">expand_more</span>
    </div>

    <Transition @enter="onExpandEnter" @after-enter="onExpandAfterEnter" @leave="onExpandLeave" @after-leave="onExpandAfterLeave"><div v-if="props.expanded && buildInfo">
      <div
        class="setting-card sub-card copyable-setting-card"
        :title="t('settings.copy_build_uuid')"
        @click="copyBuildValue(buildInfo.build_uuid, $event)"
      >
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">fingerprint</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.build_uuid') }}</div>
          <div class="setting-desc mono-build-value">{{ buildInfo.build_uuid }}</div>
        </div>
        <span class="material-symbols-rounded copy-hint-icon">content_copy</span>
      </div>
      <div
        class="setting-card sub-card copyable-setting-card"
        :title="t('settings.copy_build_time')"
        @click="copyBuildValue(buildInfo.build_timestamp, $event)"
      >
        <div class="setting-icon-wrap"><span class="material-symbols-rounded">schedule</span></div>
        <div class="setting-info">
          <div class="setting-title">{{ t('settings.build_time') }}</div>
          <div class="setting-desc mono-build-value">{{ buildInfo.build_timestamp }}</div>
        </div>
        <span class="material-symbols-rounded copy-hint-icon">content_copy</span>
      </div>
    </div></Transition>

    <div class="setting-card" style="cursor: pointer" @click="openExternalUrl(PROJECT_REPOSITORY_URL)">
      <div class="setting-icon-wrap"><span class="material-symbols-rounded">code</span></div>
      <div class="setting-info">
        <div class="setting-title">{{ t('settings.github') }}</div>
        <div class="setting-desc">{{ t('settings.github_desc') }}</div>
      </div>
      <span class="material-symbols-rounded" style="font-size: 20px; opacity: 0.3">open_in_new</span>
    </div>
    <div
      class="setting-card"
      style="cursor: pointer"
      :title="player.decoderCapabilities?.ffmpegError ?? player.decoderCapabilities?.ffmpeg?.directory ?? ''"
      @click="openExternalUrl(FFMPEG_LEGAL_URL)"
    >
      <div class="setting-icon-wrap"><span class="material-symbols-rounded">graphic_eq</span></div>
      <div class="setting-info">
        <div class="setting-title">{{ t('settings.ffmpeg_component') }}</div>
        <div class="setting-desc">{{ ffmpegComponentText }}</div>
      </div>
      <span class="material-symbols-rounded" style="font-size: 20px; opacity: 0.3">open_in_new</span>
    </div>
        </div>
</template>

<style scoped lang="scss">
@use '../../styles/settings-common' as *;

.about-card { cursor: pointer; }

.about-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-left: auto;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--md-on-surface-variant);
  opacity: 0.45;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity var(--duration-short), background var(--duration-short), color var(--duration-short);

  .material-symbols-rounded {
    font-size: 18px;
  }

  &:hover {
    opacity: 0.9;
    color: var(--md-primary);
    background: color-mix(in srgb, var(--md-primary) 10%, transparent);
  }
}

.about-wordmark {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.about-wordmark-hand {
  margin-left: 2px;
  font-family: var(--font-hand);
  font-size: 20px;
  font-weight: 600;
  color: var(--md-primary);
}
</style>
