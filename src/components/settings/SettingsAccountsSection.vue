<script setup lang="ts">
// 账号分区：平台登录态、头像兜底与退出登录入口。
// Accounts section: platform sign-in state, avatar fallback and the sign-out entry.
//
// 退出确认对话框仍由 SettingsView 持有，这里只发事件，避免把弹层和页面状态耦合。
// The sign-out confirmation dialog stays in SettingsView; this section only emits,
// keeping overlays and page state decoupled.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BilibiliCoverImage from '@/components/BilibiliCoverImage.vue'
import { useAuthStore } from '@/stores/auth'

const emit = defineEmits<{ logout: [key: string, label: string] }>()
const { t } = useI18n()
const auth = useAuthStore()

const platformAccounts = computed(() => [
  { key: 'netease', label: t('settings.netease_account'), iconSvg: '/icons/ic_netease.svg', auth: auth.netease, login: auth.loginNetease },
  { key: 'bilibili', label: t('settings.bilibili_account'), iconSvg: '/icons/ic_bilibili.svg', auth: auth.bilibili, login: auth.loginBilibili },
  { key: 'youtube', label: t('settings.youtube_account'), iconSvg: '/icons/ic_youtube.svg', auth: auth.youtube, login: auth.loginYoutube },
])

// 头像地址可能短暂失效，记录具体失败地址；换地址后仍允许重新加载。
// Avatar URLs can expire briefly; remember the exact failed URL so a new URL retries.
const failedAvatarUrls = ref<Record<string, string | null>>({})

function isAvatarLoadFailed(platform: string, avatarUrl: string | null) {
  return Boolean(avatarUrl && failedAvatarUrls.value[platform] === avatarUrl)
}

function handleAvatarError(platform: string, avatarUrl: string | null) {
  if (!avatarUrl) return
  failedAvatarUrls.value = { ...failedAvatarUrls.value, [platform]: avatarUrl }
}
</script>

<template>
        <div class="settings-section-panel" data-section="accounts">
    <div class="section-label">
      <span class="material-symbols-rounded" style="font-size: 18px">account_circle</span>
      <span>{{ t('settings.accounts') }}</span>
    </div>
    <p class="settings-section-intro">{{ t('settings.accounts_desc') }}</p>

    <div
      v-for="account in platformAccounts"
      :key="account.key"
      class="setting-card account-card"
    >
      <div class="setting-icon-wrap">
        <span class="platform-icon" :style="{ maskImage: `url(${account.iconSvg})` }"></span>
      </div>
      <div class="setting-info">
        <div class="setting-title">{{ account.label }}</div>
        <div class="setting-desc" v-if="account.auth.loggedIn">
          {{ t('settings.signed_in_as', { name: account.auth.nickname || '—' }) }}
        </div>
        <div class="setting-desc" v-else-if="auth.loggingIn === account.key">
          {{ t('settings.signing_in') }}
        </div>
        <div class="account-status" :class="{ connected: account.auth.loggedIn }">
          <span class="account-status-dot"></span>
          {{ account.auth.loggedIn ? t('settings.account_connected') : t('settings.account_not_connected') }}
        </div>
      </div>
      <template v-if="account.auth.loggedIn">
        <BilibiliCoverImage
          v-if="account.key === 'bilibili' && account.auth.avatarUrl"
          :src="account.auth.avatarUrl"
          class="account-avatar"
        >
          <span class="material-symbols-rounded account-avatar account-avatar-fallback">account_circle</span>
        </BilibiliCoverImage>
        <img
          v-else-if="account.auth.avatarUrl && !isAvatarLoadFailed(account.key, account.auth.avatarUrl)"
          :src="account.auth.avatarUrl"
          class="account-avatar"
          referrerpolicy="no-referrer"
          @error="handleAvatarError(account.key, account.auth.avatarUrl)"
        />
        <span v-else class="material-symbols-rounded account-avatar account-avatar-fallback">account_circle</span>
        <button class="account-logout-btn" @click="emit('logout', account.key, account.label)">
          <span class="material-symbols-rounded" style="font-size: 16px">logout</span>
          {{ t('settings.sign_out') }}
        </button>
      </template>
      <template v-else>
        <button
          class="account-login-btn"
          :disabled="auth.loggingIn === account.key"
          @click="account.login()"
        >
          <span v-if="auth.loggingIn === account.key" class="material-symbols-rounded spin" style="font-size: 18px">progress_activity</span>
          <span v-else>{{ t('settings.sign_in') }}</span>
        </button>
      </template>
    </div>
        </div>
</template>

<style scoped lang="scss">
@use '../../styles/settings-common' as *;

/* 账号卡片 / Account cards */
.platform-icon {
  display: block;
  width: 24px;
  height: 24px;
  background: var(--md-on-surface-variant);
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
  flex-shrink: 0;
}

.account-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.account-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--md-surface-container-highest);
  color: var(--md-on-surface-variant);
  font-size: 20px;
}

.account-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  color: var(--md-on-surface-variant);
  font-size: 11px;
}

.account-status.connected { color: var(--md-primary); }

.account-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.account-login-btn {
  padding: 6px 16px;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  background: var(--md-primary);
  color: var(--md-on-primary);
  cursor: pointer;
  transition: opacity var(--duration-short);
  white-space: nowrap;
  flex-shrink: 0;

  &:hover { opacity: 0.85; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.account-logout-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  color: var(--md-error, #FFB4AB);
  flex-shrink: 0;
  transition: background var(--duration-short);
  white-space: nowrap;

  &:hover { background: color-mix(in srgb, var(--md-error, #FFB4AB) 12%, transparent); }
}
</style>
