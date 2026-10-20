// 打开外部链接：统一错误提示，避免每个调用点各写一份 try/catch。
// Open an external link with a single shared error path instead of one try/catch per
// call site.
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useToastStore } from '@/stores/toast'
import { createLogger } from '@/utils/logger'

const log = createLogger('external-link')

export function useExternalLink() {
  const { t } = useI18n()
  const toast = useToastStore()

  async function openExternalUrl(url: string): Promise<void> {
    try {
      await openUrl(url)
    } catch (error) {
      log.error('Failed to open external URL', error)
      toast.error(t('settings.open_external_link_failed'))
    }
  }

  return { openExternalUrl }
}
