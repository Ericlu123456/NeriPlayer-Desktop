<script setup lang="ts">
// 歌单、专辑、歌手卡片的通用右键菜单：打开、复制网页链接、在浏览器中打开
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { openUrl } from '@tauri-apps/plugin-opener'
import ContextMenu from '@/components/ui/ContextMenu.vue'
import { useToastStore } from '@/stores/toast'
import type { CollectionMenuTarget } from '@/utils/collectionLinks'
import { createContextMenuItem, type ContextMenuActionItem } from '@/utils/contextMenu'
import { writeClipboardText } from '@/utils/clipboard'
import { createLogger } from '@/utils/logger'

const { t } = useI18n()
const router = useRouter()
const toast = useToastStore()
const log = createLogger('collection-context-menu')

const menu = ref<{ open: boolean; x: number; y: number; target: CollectionMenuTarget | null }>({
  open: false, x: 0, y: 0, target: null,
})

const items = computed(() => {
  const webUrl = menu.value.target?.webUrl
  return [
    createContextMenuItem(t('common.open'), { id: 'open', icon: 'open_in_full' }),
    createContextMenuItem(t('common.copy_link'), { id: 'copy-link', icon: 'link', disabled: !webUrl }),
    createContextMenuItem(t('common.open_in_browser'), { id: 'open-browser', icon: 'open_in_new', disabled: !webUrl }),
  ]
})

function open(event: MouseEvent, target: CollectionMenuTarget) {
  event.preventDefault()
  event.stopPropagation()
  menu.value = { open: true, x: event.clientX, y: event.clientY, target }
}

async function handleClick(item: ContextMenuActionItem) {
  const target = menu.value.target
  if (!target) return
  try {
    if (item.id === 'open') await router.push(target.route)
    else if (item.id === 'copy-link' && target.webUrl) {
      await writeClipboardText(target.webUrl)
      toast.success(t('player.copied'))
    } else if (item.id === 'open-browser' && target.webUrl) await openUrl(target.webUrl)
  } catch (error) {
    log.warn('collection menu action failed:', error)
    toast.error(item.id === 'copy-link' ? t('player.copy_failed') : String(error))
  }
}

defineExpose({ open })
</script>

<template>
  <ContextMenu v-model:open="menu.open" :x="menu.x" :y="menu.y" :items="items" @click="handleClick" />
</template>
