<script setup lang="ts">
import { filterAndRank, searchValue, trackSearchTokens } from '@/modules/search/textMatcher'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { useDownloadStore, type ActiveDownloadTask, type DownloadedTrack } from '@/stores/download'
import { usePlayerStore, type TrackInfo } from '@/stores/player'
import { useToastStore } from '@/stores/toast'
import M3Dialog from '@/components/ui/M3Dialog.vue'
import BilibiliCoverImage from '@/components/BilibiliCoverImage.vue'
import ContextMenu from '@/components/ui/ContextMenu.vue'
import {
  createContextMenuItem,
  createContextMenuSeparator,
  type ContextMenuActionItem,
  type ContextMenuItem,
  type ContextMenuPosition,
} from '@/utils/contextMenu'
import { createLogger } from '@/utils/logger'
import { useSettingsStore } from '@/stores/settings'
import CustomSelect from '@/components/ui/CustomSelect.vue'
import { displayAlbum } from '@/modules/library/albumDisplay'

const log = createLogger('downloads-view')

const { t, locale } = useI18n()
const downloadStore = useDownloadStore()
const player = usePlayerStore()
const toast = useToastStore()
const settings = useSettingsStore()
const props = defineProps<{ embedded?: boolean; searchQuery?: string }>()

const ownSearchQuery = ref('')
const searchQuery = computed({
  get: () => props.searchQuery ?? ownSearchQuery.value,
  set: value => { ownSearchQuery.value = value },
})
const sortBy = ref('date')
const sortDescending = ref(true)
const sortOptions = computed(() => ['date', 'title', 'artist', 'size'].map(value => ({ value, label: t(`download.sort_${value}`) })))
const parallelism = computed({ get: () => String(settings.downloadParallelism), set: value => { settings.downloadParallelism = Number(value) } })
const parallelismOptions = Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))
const selectionMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const showDeleteDialog = ref(false)
const deleteTarget = ref<DownloadedTrack | null>(null)
const batchDeleting = ref(false)
const deletionProgress = ref({ done: 0, total: 0, failed: 0 })

type DownloadContextTarget =
  | { kind: 'downloaded'; track: DownloadedTrack }
  | { kind: 'active'; task: ActiveDownloadTask }

const downloadContextMenuOpen = ref(false)
const downloadContextMenuPosition = ref<ContextMenuPosition>({ x: 0, y: 0 })
const downloadContextMenuTarget = ref<DownloadContextTarget | null>(null)

onMounted(() => {
  void downloadStore.initEvents().catch(error => log.error('Download listener failed:', error))
  downloadStore.loadDownloads()
})

const sortedDownloads = computed(() => {
  return [...downloadStore.downloads].sort((a, b) => {
    const order = sortBy.value === 'title' ? a.title.localeCompare(b.title)
      : sortBy.value === 'artist' ? a.artist.localeCompare(b.artist)
      : sortBy.value === 'size' ? a.fileSize - b.fileSize
      : (a.downloadedAt || 0) - (b.downloadedAt || 0)
    return sortDescending.value ? -order : order
  })
})

const filteredDownloads = computed(() => filterAndRank(searchQuery.value, sortedDownloads.value, track => [
  ...trackSearchTokens({ ...track, album: displayAlbum(track.album) }),
  searchValue(track.source, 10),
  searchValue(track.filePath, 12),
]))

const activeTasks = computed(() => filterAndRank(searchQuery.value, downloadStore.activeDownloads, task =>
  [searchValue(task.title, 0), searchValue(task.artist, 4), searchValue(task.source, 10)]))
const downloadedCount = computed(() => downloadStore.downloads.length)
const activeCount = computed(() => downloadStore.runningDownloadCount)
const finishedTaskCount = computed(() => downloadStore.activeDownloads.length - activeCount.value)
const totalSize = computed(() => downloadStore.downloads.reduce((sum, item) => sum + (item.fileSize || 0), 0))
const selectedCount = computed(() => selectedIds.value.size)
const visibleSelectedCount = computed(() => filteredDownloads.value.filter(item => selectedIds.value.has(item.id)).length)
const allVisibleSelected = computed(() => filteredDownloads.value.length > 0 && visibleSelectedCount.value === filteredDownloads.value.length)
const summaryText = computed(() => t('download.summary', {
  active: activeCount.value,
  downloaded: downloadedCount.value,
  size: formatFileSize(totalSize.value),
}))
const downloadedDesc = computed(() => {
  if (searchQuery.value.trim()) {
    return t('download.search_result_count', { count: filteredDownloads.value.length })
  }
  return t('download.downloaded_desc', { count: filteredDownloads.value.length })
})

const downloadContextMenuItems = computed<readonly ContextMenuItem[]>(() => {
  const target = downloadContextMenuTarget.value
  if (!target) return []

  if (target.kind === 'active') {
    if (target.task.status === 'error' || target.task.status === 'cancelled') {
      return [createContextMenuItem(t('download.retry'), { id: 'retry', icon: 'refresh' })]
    }
    const canCancel = downloadStore.isDownloading(target.task.trackId)
    return [createContextMenuItem(t('download.cancel_task'), {
      id: 'cancel',
      icon: 'close',
      danger: true,
      disabled: !canCancel,
    })]
  }

  return [
    createContextMenuItem(t('common.multi_select'), {
      id: 'select',
      icon: 'checklist',
    }),
    createContextMenuSeparator('download-selection'),
    createContextMenuItem(t('download.open_folder'), {
      id: 'open-folder',
      icon: 'folder_open',
    }),
    createContextMenuItem(t('download.redownload'), {
      id: 'redownload',
      icon: 'refresh',
      disabled: downloadStore.isDownloading(target.track.id),
    }),
    createContextMenuSeparator('download-actions'),
    createContextMenuItem(t('common.delete'), {
      id: 'delete',
      icon: 'delete',
      danger: true,
    }),
  ]
})

watch(filteredDownloads, (items) => {
  const visible = new Set(items.map(item => item.id))
  selectedIds.value = new Set([...selectedIds.value].filter(id => visible.has(id)))
  if (selectionMode.value && selectedIds.value.size === 0 && searchQuery.value.trim()) return
  if (selectionMode.value && downloadStore.downloads.length === 0) selectionMode.value = false
})

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ts?: number): string {
  if (!ts) return '—'
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts
  return new Date(ms).toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sourceLabel(source?: string): string {
  switch ((source || '').toLowerCase()) {
    case 'netease': return t('player.source_netease')
    case 'qq': return t('player.source_qq')
    case 'bilibili': return t('player.source_bilibili')
    case 'youtube': return t('player.source_youtube')
    case 'local': return t('player.source_local')
    default: return source || '—'
  }
}

function statusIcon(task: ActiveDownloadTask): string {
  switch (task.status) {
    case 'queued': return 'hourglass_top'
    case 'processing': return 'edit_note'
    case 'resolving': return 'network_node'
    case 'cancelling': return 'hourglass_top'
    case 'cancelled': return 'cancel'
    case 'error': return 'error'
    case 'already_exists': return 'download_done'
    default: return 'downloading'
  }
}

function activeDownloadStatusText(status: string) {
  switch (status) {
    case 'queued': return t('download.queued')
    case 'processing': return t('download.processing')
    case 'resolving': return t('download.resolving')
    case 'cancelling': return t('download.cancelling')
    case 'cancelled': return t('download.cancelled')
    case 'error': return t('download.download_failed')
    case 'already_exists': return t('download.already_exists')
    default: return t('download.downloading')
  }
}

function activeDownloadProgressText(task: ActiveDownloadTask) {
  if (['queued', 'resolving', 'processing', 'cancelling', 'cancelled', 'already_exists'].includes(task.status)) {
    return activeDownloadStatusText(task.status)
  }
  if (task.status === 'error') {
    return task.message
      ? `${activeDownloadStatusText(task.status)} · ${task.message}`
      : activeDownloadStatusText(task.status)
  }

  const downloaded = typeof task.downloadedBytes === 'number' ? formatFileSize(task.downloadedBytes) : ''
  const total = typeof task.totalBytes === 'number' && task.totalBytes > 0 ? formatFileSize(task.totalBytes) : ''
  const percent = typeof task.progress === 'number' ? `${task.progress}%` : ''

  const speed = task.speedBytesPerSecond ? ` · ${formatFileSize(task.speedBytesPerSecond)}/s` : ''
  if (downloaded && total && percent) return `${downloaded} / ${total} · ${percent}${speed}`
  if (downloaded && total) return `${downloaded} / ${total}${speed}`
  if (downloaded) return `${downloaded}${percent ? ` · ${percent}` : ''}${speed}`
  return activeDownloadStatusText(task.status)
}

function downloadToTrack(track: DownloadedTrack): TrackInfo {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album || '',
    durationMs: track.durationMs || 0,
    coverUrl: track.coverUrl || '',
    audioUrl: track.filePath,
  }
}

function playDownloadedTrack(track: DownloadedTrack) {
  if (selectionMode.value) {
    toggleSelected(track.id)
    return
  }
  player.play(downloadToTrack(track))
}

function openDownloadContextMenu(event: MouseEvent, target: DownloadContextTarget) {
  downloadContextMenuPosition.value = { x: event.clientX, y: event.clientY }
  downloadContextMenuTarget.value = target
  downloadContextMenuOpen.value = true
}

function handleDownloadedRowContextMenu(event: MouseEvent, track: DownloadedTrack) {
  if (selectionMode.value) {
    toggleSelected(track.id)
    return
  }
  openDownloadContextMenu(event, { kind: 'downloaded', track })
}

function handleActiveTaskContextMenu(event: MouseEvent, task: ActiveDownloadTask) {
  if (selectionMode.value) return
  openDownloadContextMenu(event, { kind: 'active', task })
}

function closeDownloadContextMenu() {
  downloadContextMenuOpen.value = false
  downloadContextMenuTarget.value = null
}

function handleDownloadContextMenuClick(item: ContextMenuActionItem) {
  const target = downloadContextMenuTarget.value
  closeDownloadContextMenu()
  if (!target) return

  if (target.kind === 'active') {
    if (item.id === 'cancel') void downloadStore.cancelDownload(target.task.trackId)
    if (item.id === 'retry') downloadStore.retryDownload(target.task.trackId)
    return
  }

  switch (item.id) {
    case 'select':
      if (target.kind === 'downloaded') enterSelectionMode(target.track)
      break
    case 'open-folder':
      void revealDownloadFile(target.track)
      break
    case 'redownload':
      void redownloadTrack(target.track)
      break
    case 'delete':
      requestDelete(target.track)
      break
  }
}

function enterSelectionMode(track?: DownloadedTrack) {
  selectionMode.value = true
  if (track) selectedIds.value = new Set(selectedIds.value).add(track.id)
}

function leaveSelectionMode() {
  selectionMode.value = false
  selectedIds.value = new Set()
}

function toggleSelected(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
  if (selectionMode.value && next.size === 0) selectionMode.value = false
}

function toggleSelectAllVisible() {
  if (allVisibleSelected.value) {
    const next = new Set(selectedIds.value)
    for (const item of filteredDownloads.value) next.delete(item.id)
    selectedIds.value = next
    if (next.size === 0) selectionMode.value = false
    return
  }

  const next = new Set(selectedIds.value)
  for (const item of filteredDownloads.value) next.add(item.id)
  selectedIds.value = next
  if (next.size > 0) selectionMode.value = true
}

function requestDelete(track: DownloadedTrack) {
  deleteTarget.value = track
  showDeleteDialog.value = true
}

function requestBatchDelete() {
  if (selectedIds.value.size === 0) return
  deleteTarget.value = null
  showDeleteDialog.value = true
}

async function confirmDelete() {
  if (batchDeleting.value) return
  batchDeleting.value = true
  deletionProgress.value = { done: 0, total: deleteTarget.value ? 1 : selectedCount.value, failed: 0 }
  try {
    if (deleteTarget.value) {
      const target = deleteTarget.value
      await downloadStore.deleteDownload(target.id)
    } else {
      const targets = downloadStore.downloads.filter(track => selectedIds.value.has(track.id))
      let deleted = 0
      for (const target of targets) {
        try {
          await downloadStore.deleteDownload(target.id, { silent: true })
          deleted++
        } catch (error) {
          deletionProgress.value.failed++
          log.error('Delete selected download failed:', error)
        } finally {
          deletionProgress.value.done++
        }
      }
      if (deleted > 0) toast.success(t('download.batch_deleted', { count: deleted }))
      if (deletionProgress.value.failed > 0) {
        toast.error(t('download.deletion_failed', { count: deletionProgress.value.failed }))
      } else leaveSelectionMode()
    }
    showDeleteDialog.value = false
    deleteTarget.value = null
  } catch (error) {
    toast.error(String(error))
  } finally {
    batchDeleting.value = false
  }
}

async function redownloadTrack(track: DownloadedTrack) {
  if (downloadStore.isDownloading(track.id)) return
  try {
    await downloadStore.redownloadTrack(downloadToTrack(track))
  } catch (error) {
    toast.error(String(error))
  }
}

async function revealDownloadFile(track: DownloadedTrack) {
  try {
    await invoke('reveal_file', { path: track.filePath })
  } catch (e) {
    log.error('Failed to reveal file:', e)
    toast.error(t('download.reveal_failed'))
  }
}

async function refreshDownloads() {
  await downloadStore.loadDownloads()
}

function progressWidth(task: ActiveDownloadTask) {
  if (task.status === 'queued') return '0%'
  if (task.status === 'cancelled' || task.status === 'already_exists') return '100%'
  return `${Math.max(4, task.progress ?? 0)}%`
}
</script>

<template>
  <div class="downloads-view" :class="{ embedded }">
    <header class="downloads-header">
      <button v-if="!embedded" class="back-btn" :title="t('download.back')" @click="$router.back()">
        <span class="material-symbols-rounded">arrow_back</span>
      </button>
      <div class="header-copy">
        <h1 v-if="!embedded">{{ t('download.manager_title') }}</h1>
        <p>{{ summaryText }}</p>
      </div>
      <div class="header-actions">
        <button v-if="finishedTaskCount > 0" class="text-button" @click="downloadStore.clearFinishedTasks()">{{ t('download.clear_finished') }}</button>
        <label class="parallelism-control"><span>{{ t('settings.download_parallelism') }}</span><CustomSelect v-model="parallelism" :options="parallelismOptions" :label="t('settings.download_parallelism')" /></label>
        <button class="icon-button" :title="t('download.refresh')" @click="refreshDownloads">
          <span class="material-symbols-rounded">refresh</span>
        </button>
        <button
          v-if="activeCount > 0"
          class="text-button danger"
          @click="downloadStore.cancelAllDownloads()"
        >
          <span class="material-symbols-rounded">close</span>
          <span>{{ t('download.cancel_all') }}</span>
        </button>
      </div>
    </header>

    <section v-if="activeTasks.length > 0" class="active-section">
      <div class="section-heading">
        <span class="material-symbols-rounded">downloading</span>
        <h2>{{ t('download.active_tasks', { count: activeTasks.length }) }}</h2>
      </div>
      <div class="task-list">
        <div
          v-for="task in activeTasks"
          :key="task.trackId"
          class="task-row"
          :class="`status-${task.status}`"
          @contextmenu.prevent.stop="handleActiveTaskContextMenu($event, task)"
        >
          <div class="task-icon cover-box">
            <BilibiliCoverImage :src="task.coverUrl" :alt="task.title">
              <span class="material-symbols-rounded">{{ statusIcon(task) }}</span>
            </BilibiliCoverImage>
          </div>
          <div class="task-main">
            <div class="task-topline">
              <div class="task-title">{{ task.title }}</div>
              <div class="task-source">{{ sourceLabel(task.source) }}</div>
            </div>
            <div class="task-subtitle">{{ task.artist || '—' }} · {{ activeDownloadProgressText(task) }}</div>
            <div
              class="progress-track"
              :class="{
                indeterminate: task.status === 'processing' || task.status === 'resolving' || (task.status === 'downloading' && !task.totalBytes),
                error: task.status === 'error',
                muted: task.status === 'queued' || task.status === 'cancelling' || task.status === 'cancelled' || task.status === 'already_exists',
              }"
            >
              <div class="progress-fill" :style="{ width: progressWidth(task) }" />
            </div>
          </div>
          <button
            v-if="task.status === 'error' || task.status === 'cancelled'"
            class="icon-action"
            :title="t('download.retry')"
            @click="downloadStore.retryDownload(task.trackId)"
          ><span class="material-symbols-rounded">refresh</span></button>
          <button
            v-else
            class="icon-action danger"
            :title="t('download.cancel_task')"
            :disabled="task.status === 'cancelling' || task.status === 'already_exists'"
            @click="downloadStore.cancelDownload(task.trackId)"
          >
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>
    </section>

    <section class="downloads-section">
      <div class="downloads-toolbar">
        <div>
          <h2>{{ t('download.downloaded_items') }}</h2>
          <p>{{ downloadedDesc }}</p>
        </div>
        <div class="toolbar-actions">
          <CustomSelect v-model="sortBy" :options="sortOptions" :label="t('download.sort')" />
          <button class="icon-action" :title="t(sortDescending ? 'download.sort_ascending' : 'download.sort_descending')" @click="sortDescending = !sortDescending"><span class="material-symbols-rounded">{{ sortDescending ? 'south' : 'north' }}</span></button>
          <div v-if="!embedded" class="search-box">
            <span class="material-symbols-rounded">search</span>
            <input v-model="searchQuery" :placeholder="t('download.search_placeholder')" />
            <button v-if="searchQuery" @click="searchQuery = ''">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
          <button
            v-if="downloadStore.downloads.length > 0 && !selectionMode"
            class="text-button"
            @click="enterSelectionMode()"
          >
            <span class="material-symbols-rounded">checklist</span>
            <span>{{ t('download.select') }}</span>
          </button>
          <template v-else-if="selectionMode">
            <button class="text-button" @click="toggleSelectAllVisible">
              <span class="material-symbols-rounded">{{ allVisibleSelected ? 'deselect' : 'select_all' }}</span>
              <span>{{ allVisibleSelected ? t('download.deselect_all') : t('download.select_all') }}</span>
            </button>
            <button class="text-button danger" :disabled="selectedCount === 0" @click="requestBatchDelete">
              <span class="material-symbols-rounded">delete</span>
              <span>{{ t('download.delete_selected', { count: selectedCount }) }}</span>
            </button>
            <button class="ghost-button" @click="leaveSelectionMode">{{ t('common.cancel') }}</button>
          </template>
        </div>
      </div>

      <div v-if="filteredDownloads.length > 0" class="download-list">
        <div
          v-for="track in filteredDownloads"
          :key="track.id"
          class="download-row"
          :class="{
            selected: selectedIds.has(track.id),
            playing: player.currentTrack?.id === track.id,
          }"
          @click="playDownloadedTrack(track)"
          @contextmenu.prevent.stop="handleDownloadedRowContextMenu($event, track)"
        >
          <button v-if="selectionMode" class="select-dot" @click.stop="toggleSelected(track.id)">
            <span class="material-symbols-rounded filled">{{ selectedIds.has(track.id) ? 'check_circle' : 'radio_button_unchecked' }}</span>
          </button>

          <div class="cover-box">
            <BilibiliCoverImage v-if="track.coverUrl" :src="track.coverUrl" loading="lazy">
              <span class="material-symbols-rounded filled">music_note</span>
            </BilibiliCoverImage>
            <span v-else class="material-symbols-rounded filled">music_note</span>
            <div class="play-overlay"><span class="material-symbols-rounded">play_arrow</span></div>
          </div>

          <div class="track-info">
            <div class="track-title">{{ track.title }}</div>
            <div class="track-meta">{{ track.artist || '—' }}<template v-if="displayAlbum(track.album)"> · {{ displayAlbum(track.album) }}</template></div>
          </div>

          <div class="track-source">{{ sourceLabel(track.source) }}</div>
          <div class="track-size">{{ formatFileSize(track.fileSize) }}</div>
          <div class="track-date">{{ formatDate(track.downloadedAt) }}</div>

          <div class="row-actions" @click.stop>
            <button class="icon-action" :title="t('download.open_folder')" @click="revealDownloadFile(track)">
              <span class="material-symbols-rounded">folder_open</span>
            </button>
            <button class="icon-action" :title="t('download.redownload')" :disabled="downloadStore.isDownloading(track.id)" @click="redownloadTrack(track)">
              <span class="material-symbols-rounded">refresh</span>
            </button>
            <button class="icon-action danger" :title="t('common.delete')" @click="requestDelete(track)">
              <span class="material-symbols-rounded">delete</span>
            </button>
          </div>
        </div>
      </div>

      <div v-else class="empty-state">
        <span class="material-symbols-rounded">download</span>
        <h3>{{ searchQuery ? t('download.search_empty_title') : t('download.empty_title') }}</h3>
        <p>{{ searchQuery ? t('download.search_empty_desc') : t('download.empty_desc') }}</p>
      </div>
    </section>

    <ContextMenu
      v-model:open="downloadContextMenuOpen"
      :x="downloadContextMenuPosition.x"
      :y="downloadContextMenuPosition.y"
      :items="downloadContextMenuItems"
      @click="handleDownloadContextMenuClick"
      @close="closeDownloadContextMenu"
    />

    <M3Dialog
      v-model:open="showDeleteDialog"
      :title="deleteTarget ? t('download.delete_confirm') : t('download.batch_delete_confirm')"
      icon="delete"
      :confirm-text="t('common.delete')"
      confirm-danger
      :confirm-disabled="batchDeleting"
      @confirm="confirmDelete"
    >
      <p class="dialog-msg">
        {{ deleteTarget
          ? t('download.delete_confirm_msg', { name: deleteTarget.title })
          : t('download.batch_delete_msg', { count: selectedCount }) }}
      </p>
      <p v-if="batchDeleting" role="status">{{ t('download.delete_progress', { done: deletionProgress.done, total: deletionProgress.total }) }}</p>
    </M3Dialog>
  </div>
</template>

<style scoped lang="scss" src="./DownloadsView.scss"></style>
