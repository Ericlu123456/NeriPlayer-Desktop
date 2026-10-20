<script setup lang="ts">
// 语言分区：四份语言文件切换，带主题色 ripples 过渡。
// Language section: switch between the four locale files with the ripple transition.
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, setLocaleWithTransition } from '@/i18n'
import { useSettingsStore } from '@/stores/settings'

const { t, locale } = useI18n()
const { locale: settingLocale } = storeToRefs(useSettingsStore())

function handleLocaleSwitch(code: string, event: MouseEvent) {
  settingLocale.value = code
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  setLocaleWithTransition(code, x, y, false)
}
</script>

<template>
        <div class="settings-section-panel" data-section="language">
    <div class="section-label">
      <span class="material-symbols-rounded" style="font-size: 18px">language</span>
      <span>{{ t('settings.language') }}</span>
    </div>

    <div class="setting-card">
      <div class="setting-icon-wrap"><span class="material-symbols-rounded">translate</span></div>
      <div class="setting-info">
        <div class="setting-title">{{ t('settings.language') }}</div>
        <div class="setting-desc">{{ t('settings.language_desc') }}</div>
      </div>
      <div class="chip-row">
        <button v-for="loc in SUPPORTED_LOCALES" :key="loc.code" class="m3-chip" :class="{ active: locale === loc.code }" @click="handleLocaleSwitch(loc.code, $event)">{{ loc.label }}</button>
      </div>
    </div>
        </div>
</template>

<style scoped lang="scss">
@use '../../styles/settings-common' as *;
</style>
