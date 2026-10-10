// 当前曲目的歌词：正在播放页与桌面歌词读的是同一份（同一来源、同一时间轴），
// 默认偏移按这份歌词记下的来源算，两边的偏移也就一致。
// 只在有界面用到时才取词：正在播放页、桌面歌词各自 acquire，都 release 后换歌不再联网
import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { usePlayerStore, type LyricLine, type TrackInfo } from '@/stores/player'
import { useSettingsStore } from '@/stores/settings'
import { getCachedLyrics, saveCachedLyrics } from '@/modules/lyrics/lyricsCache'
import { hasWordTimedLyrics, loadLyricsSingleFlight } from '@/modules/lyrics/lyricsRequest'
import {
  mapBackendLyrics,
  materializeStoredLyrics,
  mergeParsedLyricsWithRomanization,
  mergeWordTimedLyricsWithBaseline,
  resolveKnownNeteaseLyricSongId,
  resolveStoredLyricStateFromPayload,
  shouldBackfillNeteaseRomanization,
} from '@/modules/lyrics/lyricsFormat'
import { normalizeLyricSource, readSyncedLyricSource } from '@/modules/lyrics/lyricOffset'
import {
  fetchAutomaticLyrics,
  fetchNeteaseRomanization,
  fetchPreferredSourceLyrics,
  fetchWordTimedLyrics,
  preferredLyricMatchSource,
} from '@/modules/lyrics/lyricsFetch'
import { lyricSourceOf, rememberLyricSource } from '@/modules/lyrics/lyricSource'
import { getPlaybackSourceKind } from '@/modules/playback/playbackSource'
import { playbackSessionTrackKey } from '@/modules/playback/playbackRequest'
import { createLogger } from '@/utils/logger'
import { summarizeLogError } from '@/utils/logSanitizer'

const log = createLogger('lyrics')

/** 逐字升级、音译补全返回时，歌词还是不是发起时那首歌（时长常在起播后才补上，不参与比较） */
function sameSong(left: TrackInfo | null | undefined, right: TrackInfo | null | undefined): boolean {
  return !!left && !!right && left.id === right.id && left.title === right.title && left.artist === right.artist
}

export const useCurrentLyricsStore = defineStore('currentLyrics', () => {
  const player = usePlayerStore()
  const settings = useSettingsStore()
  const lines = shallowRef<LyricLine[]>([])
  const loading = ref(false)
  let consumers = 0
  let request = 0
  /** 已经按哪首歌、哪套歌词设置取过；没有界面时换歌只清空，下次 acquire 再取 */
  let loadedKey: string | null = null

  function cache(track: TrackInfo | null | undefined, value: LyricLine[]) {
    if (!track || value.length === 0) return
    void saveCachedLyrics(track, value).catch(error => log.warn('lyrics not cached:', summarizeLogError(error)))
  }

  function loadKey(): string {
    const track = player.currentTrack
    return [
      playbackSessionTrackKey(player.hasPlaybackSession, track?.playlistKey, track?.id),
      track?.id ?? '',
      settings.defaultLyricSource,
      settings.preferWordTimedLyrics,
    ].join('|')
  }

  // 同步载荷里的歌词：null 表示没有本地覆盖（可在线取）；[] 表示有意清空或解析失败
  async function materializeSynced(track: TrackInfo): Promise<LyricLine[] | null> {
    try {
      const synced = await materializeStoredLyrics(
        track.syncPayload,
        async (content, part) => mapBackendLyrics(await invoke<any[]>('parse_lrc_content', part === 'original'
          ? { content, title: track.title, artist: track.artist }
          : { content })),
        error => log.warn('stored translation or romanization not parsed:', summarizeLogError(error)),
      )
      if (synced?.length) rememberLyricSource(track, readSyncedLyricSource(track.syncPayload))
      return synced
    } catch (error) {
      log.warn('synced lyrics not materialized:', summarizeLogError(error))
      return []
    }
  }

  /** 缺逐字时间轴时后台换上 AMLL TTML / 酷狗的逐字版本；期间歌词被编辑或换歌就作废 */
  function upgradeWordTimed(track: TrackInfo, id: number) {
    const baseline = lines.value
    if (!settings.preferWordTimedLyrics || !getPlaybackSourceKind(track) || hasWordTimedLyrics(baseline)) return
    if (resolveStoredLyricStateFromPayload(track.syncPayload).kind !== 'absent') return
    void loadLyricsSingleFlight(track, () => fetchWordTimedLyrics({
      title: track.title, artist: track.artist, durationMs: track.durationMs || 0,
    }), 'word-timed').then(({ lines: upgrade, source }) => {
      const current = player.currentTrack
      if (id !== request || !settings.preferWordTimedLyrics || !sameSong(current, track) || !current) return
      if (!hasWordTimedLyrics(upgrade) || resolveStoredLyricStateFromPayload(current.syncPayload).kind !== 'absent') return
      const merged = mergeWordTimedLyricsWithBaseline(lines.value, upgrade)
      // 逐字时间轴来自 AMLL TTML / 酷狗，偏移按它们的默认算
      rememberLyricSource(current, source)
      lines.value = merged
      cache(current, merged)
    }).catch(error => log.warn('word timed lyric upgrade unavailable:', summarizeLogError(error)))
  }

  // 歌词没带音译时（同步载荷、旧缓存、非网易云来源），后台从网易云补上
  function backfillRomanization(track: TrackInfo, id: number) {
    if (!shouldBackfillNeteaseRomanization(track.syncPayload, lines.value)) return
    const stillWanted = () => id === request && sameSong(player.currentTrack, track)
      && shouldBackfillNeteaseRomanization(player.currentTrack?.syncPayload, lines.value)
    const songId = resolveKnownNeteaseLyricSongId(track)
    void fetchNeteaseRomanization(track, songId).then(async (text) => {
      if (!text || !stillWanted()) return
      const roman = mapBackendLyrics(await invoke<any[]>('parse_lrc_content', { content: text }))
      if (!stillWanted()) return
      const merged = mergeParsedLyricsWithRomanization(lines.value, roman)
      if (!merged.some(line => line.roman)) return
      lines.value = merged
      cache(track, merged)
    }).catch(error => log.warn('netease romanization backfill unavailable:', summarizeLogError(error)))
  }

  async function load() {
    const id = ++request
    loadedKey = loadKey()
    const track = player.hasPlaybackSession ? player.currentTrack : null
    // 换曲瞬间立即撤下旧词：旧词挂着时歌词视图会把归零的进度当成大幅回跳
    lines.value = []
    if (!track) {
      loading.value = false
      return
    }

    const cached = await getCachedLyrics(track)
    if (id !== request) return
    lines.value = cached || []
    loading.value = true
    try {
      // 同步歌词最优先（Android 匹配的歌词经云同步落在 syncPayload，必须压过本地旧缓存）
      const synced = await materializeSynced(track)
      if (id !== request) return
      if (synced !== null) {
        lines.value = synced
        if (synced.length) {
          cache(track, synced)
          backfillRomanization(track, id)
        }
        return
      }

      // 设了默认歌词源时先按它匹配（Android tryGetPreferredLyricSourceResult），缓存已是该来源就直接用
      const preferredSource = preferredLyricMatchSource(getPlaybackSourceKind(track), settings.defaultLyricSource)
      if (preferredSource && !(cached?.length && normalizeLyricSource(lyricSourceOf(track)) === preferredSource)) {
        const preferred = await fetchPreferredSourceLyrics(track, preferredSource, settings.preferWordTimedLyrics)
          .catch(error => { log.warn('preferred lyric source unavailable:', summarizeLogError(error)); return null })
        if (id !== request) return
        if (preferred) {
          rememberLyricSource(track, preferred.source)
          lines.value = preferred.lines
          cache(track, preferred.lines)
          backfillRomanization(track, id)
          return
        }
      }

      if (cached?.length) {
        if (!preferredSource) upgradeWordTimed(track, id)
        backfillRomanization(track, id)
        return
      }

      const fetched = await loadLyricsSingleFlight(track, async () => {
        const result = await fetchAutomaticLyrics(track, getPlaybackSourceKind(track), settings.preferWordTimedLyrics)
        if (result.lines.length > 0) {
          rememberLyricSource(track, result.source)
          cache(track, result.lines)
        }
        return result
      })
      if (id !== request) return
      lines.value = fetched.lines
      upgradeWordTimed(track, id)
      backfillRomanization(track, id)
    } catch (error) {
      log.error('lyrics not loaded:', { trackId: track.id, error: summarizeLogError(error) })
      const restored = await getCachedLyrics(track)
      if (id === request) lines.value = restored || cached || []
    } finally {
      if (id === request) loading.value = false
    }
  }

  watch(loadKey, (key) => {
    if (key === loadedKey) return
    if (consumers > 0) {
      void load()
      return
    }
    request++
    loadedKey = null
    lines.value = []
    loading.value = false
  })

  /** 界面开始显示歌词；返回的函数在界面关闭时调用 */
  function acquire(): () => void {
    consumers++
    if (loadedKey !== loadKey()) void load()
    let released = false
    return () => {
      if (released) return
      released = true
      consumers = Math.max(0, consumers - 1)
    }
  }

  /** 用户编辑、匹配、获取歌曲信息换上的歌词：作废进行中的加载与升级，免得被它们盖回去 */
  function replace(next: LyricLine[]) {
    request++
    loadedKey = loadKey()
    loading.value = false
    lines.value = next
  }

  return { lines, loading, acquire, replace }
})
