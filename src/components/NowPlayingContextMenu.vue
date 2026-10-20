<script setup lang="ts">
// 正在播放页右键菜单：标题/歌手复制、分享、加入歌单、打开歌手、保存封面、封面样式。
// Now-playing context menu: copy title/artist, share, add to playlist, open artist,
// save cover and switch cover style.
//
// 位置与可见性由本组件持有；父组件只通过 ref 调用 openContextMenu/openArtistPage。
// This component owns position/visibility; the parent calls openContextMenu and
// openArtistPage through a template ref.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import ContextMenu from './ui/ContextMenu.vue'
import {
  createContextMenuItem,
  createContextMenuSeparator,
  type ContextMenuActionItem,
  type ContextMenuItem,
} from '@/utils/contextMenu'
import { normalizeProxiedCoverUrl, resolveCoverImage } from '@/utils/bilibiliCover'
import { neteaseSongArtists } from '@/modules/library/artistNavigation'
import { splitArtistNames } from '@/modules/library/localArtists'
import { getPlaybackSourceKind } from '@/modules/playback/playbackSource'
import { usePlayerStore } from '@/stores/player'
import { useSettingsStore } from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { createLogger } from '@/utils/logger'

const props = defineProps<{
  coverUrl: string
  copyText: (text: string) => Promise<void>
}>()
const emit = defineEmits<{ collapse: []; addToPlaylist: []; share: [] }>()

const player = usePlayerStore()
const settings = useSettingsStore()
const toast = useToastStore()
const router = useRouter()
const { t } = useI18n()
const log = createLogger('now-playing')

// 右键菜单（歌曲名/歌手复制 + 封面保存）
const contextMenu = ref({ show: false, x: 0, y: 0, type: '' as 'title' | 'artist' | 'cover' | 'artist-page' })
const artistLinks = ref<Array<{ id: string; name: string; route: { name: string; params: Record<string, string>; query?: Record<string, string> } }>>([])
const artistLinkTrackId = ref('')
const artistLinksLoading = ref(false)

async function openArtistPage(event: MouseEvent) {
  const track = player.currentTrack
  if (!track?.artist.trim() || artistLinksLoading.value) return
  const source = getPlaybackSourceKind(track)
  if (source === 'qq') {
    await router.push({ name: 'explore', query: { q: track.artist, platform: 'netease', kind: 'artists' } })
    emit('collapse')
    return
  }
  artistLinksLoading.value = true
  try {
    let links: typeof artistLinks.value
    if (source === 'youtube') {
      // 对齐 Android resolveYouTubeMusicCreators：按名字精确匹配创作者，匹配不到再退回创作者搜索
      const creators = await invoke<Array<{ id: string; name: string; cover_url: string | null }>>('resolve_youtube_creators', { artist: track.artist })
      links = creators.map(creator => ({
        id: creator.id, name: creator.name,
        route: { name: 'youtube-artist', params: { browseId: creator.id }, query: { name: creator.name, cover: creator.cover_url || '' } },
      }))
      if (!links.length) {
        if (player.currentTrack?.id !== track.id) return
        await router.push({ name: 'explore', query: { q: track.artist, platform: 'youtube', kind: 'creators' } })
        emit('collapse')
        return
      }
    } else if (source === 'bilibili') {
      // 对齐 Android resolveBiliUploader：B 站的「歌手」就是视频的 UP 主
      const bvid = `${track.id} ${track.syncPayload?.audioId ?? track.syncPayload?.audio_id ?? ''}`.match(/BV[0-9A-Za-z]{10}/)?.[0]
      const uploader = bvid ? await invoke<{ id: string; name: string; cover_url: string | null } | null>('resolve_bili_uploader', { bvid }) : null
      if (!uploader) {
        toast.show(t('player.bili_uploader_unavailable'), 'info')
        return
      }
      links = [{
        id: uploader.id, name: uploader.name,
        route: { name: 'bili-artist', params: { mid: uploader.id }, query: { name: uploader.name, cover: uploader.cover_url || '' } },
      }]
    } else if (source === 'netease') {
      const rawId = track.syncPayload?.audioId ?? track.syncPayload?.audio_id ?? track.id.replace(/^netease:/i, '')
      const songId = Number(rawId)
      if (!Number.isSafeInteger(songId) || songId <= 0) return
      const detail = await invoke('get_netease_song_detail', { songId })
      links = neteaseSongArtists(detail, songId).map(artist => ({
        id: String(artist.id), name: artist.name,
        route: { name: 'netease-artist', params: { id: String(artist.id) } },
      }))
    } else {
      links = splitArtistNames(track.artist).map(name => ({
        id: name, name, route: { name: 'local-artist', params: { name } },
      }))
    }
    if (player.currentTrack?.id !== track.id) return
    if (links.length === 1) {
      await router.push(links[0]!.route)
      emit('collapse')
    } else if (links.length > 1) {
      artistLinks.value = links
      artistLinkTrackId.value = track.id
      contextMenu.value = { show: true, x: event.clientX, y: event.clientY, type: 'artist-page' }
    }
  } catch (error) {
    log.warn('failed to open artist page:', error)
    toast.error(t('player.artist_load_failed'))
  } finally {
    artistLinksLoading.value = false
  }
}

watch(() => player.hasPlaybackSession, (hasSession) => {
  if (!hasSession) contextMenu.value.show = false
})

const contextMenuItems = computed<ContextMenuItem[]>(() => {
  if (contextMenu.value.type === 'artist-page') {
    return artistLinks.value.map(artist => ({ id: artist.id, label: artist.name, icon: 'person' }))
  }
  const track = player.currentTrack
  if (contextMenu.value.type === 'title') {
    return [
      createContextMenuItem(t('player.copy_title'), { id: 'copy-title', icon: 'content_copy' }),
      createContextMenuItem(t('player.copy_track_info'), { id: 'copy-info', icon: 'copy_all', disabled: !track?.artist.trim() }),
      createContextMenuItem(t('player.share'), { id: 'share', icon: 'share' }),
      createContextMenuSeparator('title-actions'),
      createContextMenuItem(t('player.add_to_playlist'), { id: 'add-to-playlist', icon: 'playlist_add' }),
    ]
  }
  if (contextMenu.value.type === 'artist') {
    return [
      createContextMenuItem(t('player.open_artist'), { id: 'open-artist', icon: 'person', disabled: artistLinksLoading.value || !track?.artist.trim() }),
      createContextMenuItem(t('player.copy_artist'), { id: 'copy-artist', icon: 'content_copy', disabled: !track?.artist.trim() }),
    ]
  }
  return [
    createContextMenuItem(t('player.save_cover'), { id: 'save-cover', icon: 'save', disabled: !props.coverUrl }),
    createContextMenuSeparator('cover-style'),
    createContextMenuItem(t('settings.cover_style_card'), { id: 'cover-style-card', icon: settings.coverStyle === 'card' ? 'check' : 'crop_square' }),
    createContextMenuItem(t('settings.cover_style_disc'), { id: 'cover-style-disc', icon: settings.coverStyle === 'disc' ? 'check' : 'album' }),
  ]
})

function openContextMenu(e: MouseEvent, type: 'title' | 'artist' | 'cover') {
  e.preventDefault()
  contextMenu.value = { show: true, x: e.clientX, y: e.clientY, type }
}

function closeContextMenu() {
  contextMenu.value.show = false
}

// 复制后关闭菜单；复制动作本身由父组件提供，避免重复实现 toast/错误处理。
// Close after copying; the copy action lives in the parent so toast/error handling
// is not duplicated.
async function copyAndClose(text: string) {
  await props.copyText(text)
  closeContextMenu()
}

function handleContextMenuClick(item: ContextMenuActionItem) {
  if (contextMenu.value.type === 'artist-page') {
    const artist = artistLinks.value.find(link => link.id === item.id)
    if (artist && player.currentTrack?.id === artistLinkTrackId.value) {
      void router.push(artist.route).then(() => emit('collapse'))
    }
    closeContextMenu()
    return
  }
  const track = player.currentTrack
  const { x, y } = contextMenu.value
  switch (item.id) {
    case 'copy-title': void copyAndClose(track?.title || ''); break
    case 'copy-info': void copyAndClose(track ? `${track.title} - ${track.artist}` : ''); break
    case 'copy-artist': void copyAndClose(track?.artist || ''); break
    case 'share': closeContextMenu(); emit('share'); break
    case 'add-to-playlist': closeContextMenu(); emit('addToPlaylist'); break
    case 'open-artist': closeContextMenu(); void openArtistPage(new MouseEvent('click', { clientX: x, clientY: y })); break
    case 'save-cover': void saveCoverArt(); break
    case 'cover-style-card': settings.coverStyle = 'card'; closeContextMenu(); break
    case 'cover-style-disc': settings.coverStyle = 'disc'; closeContextMenu(); break
  }
}

/** 网络封面走后端代理（带 Referer，绕开图床的跨域限制），本地封面直接读 asset 地址 */
async function readCoverBytes(src: string): Promise<{ bytes: Uint8Array; extension: string }> {
  let dataUrl = src.startsWith('data:') ? src : ''
  if (!dataUrl && normalizeProxiedCoverUrl(src)) dataUrl = await resolveCoverImage(src)
  const match = /^data:image\/([\w+.-]+);base64,(.*)$/is.exec(dataUrl)
  if (match) {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return { bytes, extension: imageExtension(match[1]) }
  }
  const response = await fetch(src)
  if (!response.ok) throw new Error(`cover request failed: ${response.status}`)
  const blob = await response.blob()
  return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: imageExtension(blob.type.replace(/^image\//, '')) }
}

function imageExtension(subtype: string): string {
  const normalized = subtype.toLowerCase()
  if (normalized === 'jpeg' || normalized === 'pjpeg') return 'jpg'
  return /^(png|webp|gif|avif|bmp)$/.test(normalized) ? normalized : 'jpg'
}

async function saveCoverArt() {
  closeContextMenu()
  const src = props.coverUrl || player.currentTrack?.coverUrl
  if (!src) return

  try {
    const { bytes, extension } = await readCoverBytes(src)
    const { save } = await import('@tauri-apps/plugin-dialog')
    const baseName = (player.currentTrack?.title || 'cover').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'cover'
    const filePath = await save({
      defaultPath: `${baseName}.${extension}`,
      filters: [{ name: 'Image', extensions: [extension] }],
    })
    if (!filePath) return

    await invoke('save_file_bytes', {
      path: filePath,
      data: Array.from(bytes),
    })
    toast.success(t('player.cover_saved'))
  } catch (e) {
    log.error('Save cover failed:', e)
    toast.error(t('player.cover_save_failed'))
  }
}

defineExpose({
  openContextMenu,
  openArtistPage,
  artistLinksLoading,
  closeContextMenu,
  isContextMenuOpen: computed(() => contextMenu.value.show),
})

</script>

<template>
  <ContextMenu
    :open="player.hasPlaybackSession && contextMenu.show"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :items="contextMenuItems"
    @update:open="contextMenu.show = $event"
    @close="closeContextMenu"
    @click="handleContextMenuClick"
  />
</template>

