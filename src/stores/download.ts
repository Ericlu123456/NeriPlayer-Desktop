import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { TrackInfo } from './player'
import { useSettingsStore } from './settings'
import { useToastStore } from './toast'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'
import { resolveDownloadSource } from '@/modules/playback/playbackSource'
import { DownloadQueue } from '@/modules/download/downloadQueue'
import {
  consumeResolvingCancellation,
  markResolvingTasksCancelled,
} from '@/modules/download/downloadCancellation'

const log = createLogger('download')

export interface DownloadedTrack {
  id: string
  title: string
  artist: string
  album: string
  durationMs: number
  coverUrl: string | null
  source: string
  filePath: string
  fileSize: number
  downloadedAt: number
}

interface DownloadValidationResult {
  tracks: any[]
  removed_count?: number
  removedCount?: number
  integrity_mismatch_count?: number
  integrityMismatchCount?: number
}

export interface ActiveDownloadTask {
  trackId: string
  title: string
  artist: string
  source: string
  status: 'queued' | 'resolving' | 'downloading' | 'processing' | 'cancelling' | 'cancelled' | 'error' | 'already_exists'
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
  message?: string
  speedBytesPerSecond?: number
}

export const useDownloadStore = defineStore('download', () => {
  const downloads = ref<DownloadedTrack[]>([])
  const downloading = ref<Map<string, ActiveDownloadTask>>(new Map())
  const activeDownloads = computed(() => Array.from(downloading.value.values()))
  const runningDownloadCount = computed(() => activeDownloads.value.filter(task =>
    ['queued', 'resolving', 'downloading', 'processing', 'cancelling'].includes(task.status),
  ).length)
  const settings = useSettingsStore()
  const queue = new DownloadQueue(() => settings.downloadParallelism)
  const requestedTracks = new Map<string, TrackInfo>()
  const speedSamples = new Map<string, { bytes: number; time: number }>()
  watch(() => settings.downloadParallelism, () => queue.refresh())

  // resolving 阶段的请求 token 集合，后端尚无任务时先在前端取消（DL-7）
  const resolvingCancelled = new Set<string>()
  let resolvingTokenSequence = 0
  const resolvingRequestTokens = new Map<string, string>()

  let eventsInitialized = false
  let eventsReady: Promise<void> | null = null
  let eventsGeneration = 0
  const terminalCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let unlistenProgress: (() => void) | null = null
  let unlistenDirFallback: (() => void) | null = null
  let unlistenDownloadsChanged: (() => void) | null = null

  function initEvents() {
    if (eventsInitialized) return eventsReady ?? Promise.resolve()
    eventsInitialized = true
    const generation = ++eventsGeneration

    // 保存 UnlistenFn 并在 HMR dispose 时反注册, 避免 dev 下模块热重载重复挂监听
    // 导致重复 toast / 重复 loadDownloads（DL-13）
    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        if (eventsGeneration !== generation) return
        eventsInitialized = false
        eventsReady = null
        eventsGeneration += 1
        unlistenProgress?.()
        unlistenDirFallback?.()
        unlistenDownloadsChanged?.()
        unlistenProgress = null
        unlistenDirFallback = null
        unlistenDownloadsChanged = null
      })
    }

    const progressListening = listen<{ trackId: string; status: string; fileSize?: number; message?: string; downloadedBytes?: number; totalBytes?: number }>(
      'download-progress',
      (e) => {
        const { trackId, status, message, downloadedBytes, totalBytes } = e.payload
        const toast = useToastStore()
        const current = downloading.value.get(trackId)

        if (status === 'queued' || status === 'processing') {
          setTaskStatus(trackId, status)
        } else if (status === 'start') {
          clearTerminalCleanup(trackId)
          downloading.value = new Map(downloading.value.set(trackId, {
            trackId,
            title: current?.title || trackId,
            artist: current?.artist || '',
            source: current?.source || '',
            status: 'downloading',
            progress: current?.progress,
            downloadedBytes: current?.downloadedBytes,
            totalBytes: current?.totalBytes,
          }))
        } else if (status === 'downloading') {
          clearTerminalCleanup(trackId)
          const progress = totalBytes && totalBytes > 0
            ? Math.max(0, Math.min(100, Math.round((downloadedBytes || 0) / totalBytes * 100)))
            : undefined

          const time = Date.now()
          const sample = speedSamples.get(trackId)
          const bytes = downloadedBytes ?? current?.downloadedBytes ?? 0
          const speed = sample && time > sample.time && bytes >= sample.bytes
            ? (bytes - sample.bytes) * 1000 / (time - sample.time)
            : current?.speedBytesPerSecond
          speedSamples.set(trackId, { bytes, time })
          downloading.value = new Map(downloading.value.set(trackId, {
            trackId,
            title: current?.title || trackId,
            artist: current?.artist || '',
            source: current?.source || '',
            status: 'downloading',
            progress,
            downloadedBytes: downloadedBytes ?? current?.downloadedBytes,
            totalBytes: totalBytes ?? current?.totalBytes,
            speedBytesPerSecond: speed,
          }))
        } else if (status === 'complete') {
          clearTerminalCleanup(trackId)
          downloading.value.delete(trackId)
          downloading.value = new Map(downloading.value)
          requestedTracks.delete(trackId)
          speedSamples.delete(trackId)
          queue.finish(trackId)
          void handleCompletedDownload(trackId, toast)
        } else if (status === 'error') {
          setTaskTerminalStatus(trackId, 'error', message)
          queue.finish(trackId)
          toast.error((i18n.global as any).t('download.download_failed') + (message ? `: ${message}` : ''))
        } else if (status === 'cancelled') {
          setTaskTerminalStatus(trackId, 'cancelled')
          queue.finish(trackId)
          toast.show((i18n.global as any).t('download.cancelled'), 'info')
        } else if (status === 'already_exists') {
          setTaskTerminalStatus(trackId, 'already_exists')
          requestedTracks.delete(trackId)
          queue.finish(trackId)
          toast.show((i18n.global as any).t('download.already_exists'), 'info')
        }
      },
    )
    const progressReady = progressListening
      .then((un) => {
        if (eventsGeneration === generation && eventsInitialized) {
          unlistenProgress = un
        } else {
          un()
        }
      })
      .catch((error) => {
        if (eventsGeneration === generation) {
          eventsGeneration++
          eventsInitialized = false
          eventsReady = null
          unlistenDirFallback?.()
          unlistenDownloadsChanged?.()
          unlistenDirFallback = null
          unlistenDownloadsChanged = null
        }
        log.error('Register download progress listener failed:', error)
        throw error
      })

    // 自定义下载目录不可用回退默认目录时提示用户（DL-11），避免以为文件落在所选目录
    const fallbackListening = listen<{ requestedDir: string }>('download-dir-fallback', () => {
      const toast = useToastStore()
      toast.show((i18n.global as any).t('download.dir_fallback'), 'info')
    })
    void fallbackListening
      .then((un) => {
        if (eventsGeneration === generation && eventsInitialized) {
          unlistenDirFallback = un
        } else {
          un()
        }
      })
      .catch((error) => log.error('Register download fallback listener failed:', error))
    void listen('downloads-changed', () => { void loadDownloads() })
      .then((unlisten) => {
        if (eventsGeneration === generation && eventsInitialized) unlistenDownloadsChanged = unlisten
        else unlisten()
      })
      .catch(error => log.error('Register downloads changed listener failed:', error))
    eventsReady = progressReady
    // 旧调用方只注册事件，下载入口仍通过返回的 Promise 等待并处理失败
    void eventsReady.catch(() => {})
    return eventsReady
  }

  function clearTerminalCleanup(trackId: string) {
    const timer = terminalCleanupTimers.get(trackId)
    if (timer) {
      clearTimeout(timer)
      terminalCleanupTimers.delete(trackId)
    }
  }

  function setTaskStatus(trackId: string, status: ActiveDownloadTask['status'], message?: string) {
    const current = downloading.value.get(trackId)
    downloading.value = new Map(downloading.value.set(trackId, {
      trackId,
      title: current?.title || trackId,
      artist: current?.artist || '',
      source: current?.source || '',
      status,
      progress: current?.progress,
      downloadedBytes: current?.downloadedBytes,
      totalBytes: current?.totalBytes,
      message,
      speedBytesPerSecond: current?.speedBytesPerSecond,
    }))
  }

  function setTaskTerminalStatus(trackId: string, status: Extract<ActiveDownloadTask['status'], 'cancelled' | 'error' | 'already_exists'>, message?: string) {
    clearTerminalCleanup(trackId)
    if (!downloading.value.has(trackId) && !requestedTracks.has(trackId)) return
    setTaskStatus(trackId, status, message)
    speedSamples.delete(trackId)
    if (status === 'error' || status === 'cancelled') return
    const timer = setTimeout(() => {
      terminalCleanupTimers.delete(trackId)
      const current = downloading.value.get(trackId)
      if (current?.status === status) {
        downloading.value.delete(trackId)
        downloading.value = new Map(downloading.value)
      }
    }, 1800)
    terminalCleanupTimers.set(trackId, timer)
  }

  async function handleCompletedDownload(trackId: string, toast: ReturnType<typeof useToastStore>) {
    await loadDownloads()
    const downloaded = downloads.value.find(t => t.id === trackId)
    const t = (key: string, params?: Record<string, unknown>) => (i18n.global as any).t(key, params)
    if (downloaded?.filePath) {
      toast.success(t('download.downloaded'), {
        duration: 6000,
        action: {
          label: t('download.open_folder'),
          handler: async () => {
            await invoke('reveal_file', { path: downloaded.filePath })
          },
        },
      })
      return
    }
    toast.success(t('download.downloaded'))
  }

  async function loadDownloads() {
    try {
      const result = await invoke<DownloadValidationResult>('validate_downloads')
      const raw = result.tracks || []
      downloads.value = (raw || []).map((t: any) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationMs: t.duration_ms,
        coverUrl: t.cover_url || null,
        source: t.source,
        filePath: t.file_path,
        fileSize: t.file_size,
        downloadedAt: t.downloaded_at,
      }))
      const removedCount = result.removed_count ?? result.removedCount ?? 0
      if (removedCount > 0) {
        const toast = useToastStore()
        toast.show((i18n.global as any).t('download.missing_cleaned', { count: removedCount }), 'info')
      }
      const mismatchCount = result.integrity_mismatch_count
        ?? result.integrityMismatchCount
        ?? 0
      if (mismatchCount > 0) {
        const toast = useToastStore()
        toast.show(
          (i18n.global as any).t('download.integrity_mismatch', { count: mismatchCount }),
          'info',
        )
      }
    } catch (e) {
      log.error('Load downloads failed:', e)
    }
  }

  /**
   * 下载曲目：先解析音频 URL（按来源分支），再调用后端下载
   */
  async function downloadTrack(track: TrackInfo) {
    const toast = useToastStore()

    if (isDownloaded(track.id)) {
      toast.success((i18n.global as any).t('download.downloaded'))
      return
    }

    if (queue.has(track.id)) {
      return // 正在下载中
    }

    const source = track.id.startsWith('netease:')
      ? 'netease'
      : track.id.startsWith('qq:')
        ? 'qq'
      : track.id.startsWith('bilibili:')
        ? 'bilibili'
        : track.id.startsWith('youtube:')
          ? 'youtube'
          : 'local'

    if (source === 'local') {
      toast.error((i18n.global as any).t('player.not_available'))
      return
    }
    clearTerminalCleanup(track.id)
    requestedTracks.set(track.id, { ...track })
    downloading.value = new Map(downloading.value.set(track.id, {
      trackId: track.id, title: track.title, artist: track.artist, source,
      status: 'queued', progress: 0, downloadedBytes: 0,
    }))
    queue.enqueue(track.id, () => { void startDownload(track, source) })
  }

  async function startDownload(track: TrackInfo, source: string) {
    const toast = useToastStore()
    const requestToken = `${track.id}:${++resolvingTokenSequence}`
    resolvingRequestTokens.set(track.id, requestToken)
    downloading.value = new Map(downloading.value.set(track.id, {
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      source,
      status: 'resolving',
      progress: 0,
      downloadedBytes: 0,
    }))
    toast.success((i18n.global as any).t('download.downloading'))

    try {
      await initEvents()
      if (consumeResolvingCancellation(resolvingCancelled, requestToken)) {
        resolvingRequestTokens.delete(track.id)
        setTaskTerminalStatus(track.id, 'cancelled')
        queue.finish(track.id)
        return
      }
      const follow = settings.downloadFollowPlaybackQuality
      const youtubeQuality = follow ? settings.youtubeQuality : settings.downloadYoutubeQuality
      const resolved = await resolveDownloadSource(track, {
        neteaseQuality: follow ? settings.neteaseQuality : settings.downloadNeteaseQuality,
        qqMusicQuality: follow ? settings.qqMusicQuality : settings.downloadQqMusicQuality,
        biliQuality: follow ? settings.biliQuality : settings.downloadBiliQuality,
        youtubeQuality,
        youtubePlaybackSource: settings.youtubePlaybackSource,
      })

      // 解析期间被取消则不再启动后端下载（DL-7）
      if (consumeResolvingCancellation(resolvingCancelled, requestToken)) {
        if (resolvingRequestTokens.get(track.id) === requestToken) {
          resolvingRequestTokens.delete(track.id)
        }
        setTaskTerminalStatus(track.id, 'cancelled')
        queue.finish(track.id)
        return
      }

      // 确定来源
      await invoke('download_track', {
        url: resolved.url,
        streamType: resolved.streamType ?? 'direct',
        expectedContentLength: resolved.expectedContentLength,
        expectedContentMd5: resolved.expectedContentMd5,
        youtubeVideoId: source === 'youtube' ? track.id.slice('youtube:'.length) : null,
        youtubeQuality: source === 'youtube' ? youtubeQuality : null,
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album || '',
        durationMs: resolved.durationMs || track.durationMs,
        coverUrl: track.coverUrl || null,
        source,
        downloadDir: useSettingsStore().downloadDir || null,
        nameTemplate: useSettingsStore().downloadNameTemplate || null,
      })

      // 取消可能与启动命令并发发生，命令返回后再消费一次 token，
      // 确保后端任务已注册后仍能收到取消请求
      if (consumeResolvingCancellation(resolvingCancelled, requestToken)) {
        if (resolvingRequestTokens.get(track.id) === requestToken) {
          try {
            await invoke('cancel_download', { trackId: track.id })
          } catch (cancelError) {
            log.error('Cancel download after launch failed:', cancelError)
          }
        }
      }
      if (resolvingRequestTokens.get(track.id) === requestToken) {
        resolvingRequestTokens.delete(track.id)
      }
    } catch (e: any) {
      log.error('Download failed:', e)
      const wasCancelled = resolvingCancelled.has(requestToken)
      if (resolvingRequestTokens.get(track.id) === requestToken) {
        resolvingRequestTokens.delete(track.id)
      }
      resolvingCancelled.delete(requestToken)
      const msg = typeof e === 'string' ? e : e?.message || String(e)
      const lowerMsg = msg.toLowerCase()
      if (wasCancelled || lowerMsg.includes('cancelled') || lowerMsg.includes('canceled')) {
        setTaskTerminalStatus(track.id, 'cancelled')
      } else {
        setTaskTerminalStatus(track.id, 'error', msg)
      }
      queue.finish(track.id)
      if (!wasCancelled && !msg.includes('already downloaded') && !lowerMsg.includes('cancelled') && !lowerMsg.includes('canceled')) {
        toast.error((i18n.global as any).t('download.download_failed') + `: ${msg}`)
      }
    }
  }

  async function deleteDownload(trackId: string, options: { silent?: boolean } = {}) {
    try {
      await invoke('delete_download', { trackId })
      downloads.value = downloads.value.filter(t => t.id !== trackId)
      if (!options.silent) {
        const toast = useToastStore()
        toast.success((i18n.global as any).t('download.deleted'))
      }
    } catch (e) {
      log.error('Delete download failed:', e)
      throw e
    }
  }

  async function redownloadTrack(track: TrackInfo) {
    if (isDownloading(track.id)) return
    if (isDownloaded(track.id)) {
      await deleteDownload(track.id, { silent: true })
    }
    await downloadTrack(track)
  }

  function isDownloaded(trackId: string): boolean {
    return downloads.value.some(t => t.id === trackId)
  }

  function isDownloading(trackId: string): boolean {
    const status = downloading.value.get(trackId)?.status
    return !!status && ['queued', 'resolving', 'downloading', 'processing', 'cancelling'].includes(status)
  }

  function getDownloadedTrack(trackId: string): DownloadedTrack | undefined {
    return downloads.value.find(t => t.id === trackId)
  }

  async function cancelDownload(trackId: string) {
    const current = downloading.value.get(trackId)
    const resolvingToken = resolvingRequestTokens.get(trackId)
    if (queue.cancelPending(trackId)) {
      setTaskTerminalStatus(trackId, 'cancelled')
      return true
    }
    if (current?.status === 'cancelling') return true
    if (!current || !isDownloading(trackId)) return false
    if (current.status === 'resolving' && resolvingToken) {
      // 在等待 IPC 前取消解析代际，避免解析先完成后漏掉后台任务
      resolvingCancelled.add(resolvingToken)
    }

    try {
      if (current) {
        setTaskStatus(trackId, 'cancelling')
      }
      const cancelled = await invoke<boolean>('cancel_download', { trackId })
      if (cancelled) {
        return true
      }
      // 后端查无任务：任务仍处于 resolving 阶段（URL 解析中）。标记取消，
      // 待解析完成时跳过后端下载，而不是误报取消失败（DL-7）
      if (current.status === 'resolving' && resolvingToken) {
        if (resolvingRequestTokens.get(trackId) === resolvingToken) {
          setTaskTerminalStatus(trackId, 'cancelled')
        }
        return true
      }
      if (downloading.value.get(trackId)?.status === 'cancelling') {
        setTaskStatus(trackId, current.status, (i18n.global as any).t('download.cancel_failed'))
      }
    } catch (e) {
      log.error('Cancel download failed:', e)
      if (current.status === 'resolving' && resolvingToken) {
        if (resolvingRequestTokens.get(trackId) === resolvingToken) setTaskTerminalStatus(trackId, 'cancelled')
        return true
      }
      if (downloading.value.get(trackId)?.status === 'cancelling') {
        setTaskStatus(trackId, current.status, (i18n.global as any).t('download.cancel_failed'))
      }
    }
    return false
  }

  async function cancelAllDownloads() {
    const toast = useToastStore()
    const visibleActiveCount = Array.from(downloading.value.values())
      .filter(task => isDownloading(task.trackId))
      .length
    for (const task of activeDownloads.value) {
      if (queue.cancelPending(task.trackId)) setTaskTerminalStatus(task.trackId, 'cancelled')
    }
    const resolvingIds = markResolvingTasksCancelled(
      downloading.value.values(),
      resolvingCancelled,
      trackId => resolvingRequestTokens.get(trackId),
    )
    try {
      const cancelled = await invoke<number>('cancel_all_downloads')
      for (const { trackId, token } of resolvingIds) {
        if (
          resolvingRequestTokens.get(trackId) === token
          && downloading.value.get(trackId)?.status === 'resolving'
        ) {
          setTaskTerminalStatus(trackId, 'cancelled')
        }
      }
      if (cancelled > 0) {
        const next = new Map(downloading.value)
        for (const [trackId, task] of next.entries()) {
          if (task.status === 'downloading' || task.status === 'processing') {
            next.set(trackId, { ...task, status: 'cancelling' })
          }
        }
        downloading.value = next
      }
      // 后端任务可能在快照和 cancel_all_downloads 之间注册，按可见任务数去重计数
      const totalCancelled = Math.max(cancelled, visibleActiveCount)
      toast.show(
        totalCancelled > 0
          ? (i18n.global as any).t('download.cancelled_count', { count: totalCancelled })
          : (i18n.global as any).t('settings.no_active_downloads'),
        'info',
      )
    } catch (e) {
      log.error('Cancel downloads failed:', e)
      for (const { trackId, token } of resolvingIds) {
        if (
          resolvingRequestTokens.get(trackId) === token
          && downloading.value.get(trackId)?.status === 'resolving'
        ) {
          setTaskTerminalStatus(trackId, 'cancelled')
        }
      }
      toast.error((i18n.global as any).t('download.cancel_failed'))
    }
  }

  function retryDownload(trackId: string) {
    const track = requestedTracks.get(trackId)
    if (track && !isDownloading(trackId)) void downloadTrack(track)
  }

  function clearFinishedTasks() {
    for (const task of activeDownloads.value) {
      if (isDownloading(task.trackId)) continue
      clearTerminalCleanup(task.trackId)
      requestedTracks.delete(task.trackId)
      downloading.value.delete(task.trackId)
    }
    downloading.value = new Map(downloading.value)
  }

  return {
    downloads,
    downloading,
    activeDownloads,
    runningDownloadCount,
    retryDownload,
    clearFinishedTasks,
    loadDownloads,
    downloadTrack,
    redownloadTrack,
    deleteDownload,
    isDownloaded,
    isDownloading,
    getDownloadedTrack,
    cancelDownload,
    cancelAllDownloads,
    initEvents,
  }
})
