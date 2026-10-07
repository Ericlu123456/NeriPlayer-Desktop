// 逐曲歌词偏移 store：对齐 Android 的两层偏移模型
//
//   - 各歌词来源的默认偏移: settings 里网易云、QQ 音乐、酷狗、LRCLIB、AMLL TTML 五项
//   - 逐曲用户偏移(delta): 默认 0, 只有对该曲手动微调后才非 0, 本地持久化并随同步上传
// 有效偏移 = 当前歌词来源的默认 + delta。界面显示和编辑有效偏移（绝对值），这里换算成 delta 存。
// delta 以曲目 id 为键存本地, 并可从同步载荷里读取 Android 写下的逐曲值(sync-in)。
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import {
  clampLyricOffsetMs,
  LYRIC_OFFSET_SOURCES,
  lyricUserOffsetStorageKey,
  readSyncedUserOffsetMs,
  rebaseLyricUserOffsetMs,
  resolveLyricDefaultOffsetMs,
  resolveLyricOffsetSource,
  shouldRebaseLyricOffset,
  withUpdatedUserOffsetPayload,
  type LyricOffsetSource,
} from '@/modules/lyrics/lyricOffset'
import { lyricSourceOf } from '@/modules/lyrics/lyricSource'
import { persistTrackSyncPayload } from '@/modules/lyrics/syncTrackPayload'
import { usePlayerStore, type TrackInfo } from '@/stores/player'
import {
  LEGACY_LYRIC_OFFSETS_KEY,
  persistUserData,
  preloadedUserData,
} from '@/modules/persistence/userData'
import { createLogger } from '@/utils/logger'

const STORAGE_KEY = LEGACY_LYRIC_OFFSETS_KEY
// 调整逐曲偏移时当时用的是哪个来源的默认；改默认时据此只 rebase 用这个来源的歌。只存本机
const SOURCES_STORAGE_KEY = 'neri:lyric-offset-sources'
const log = createLogger('lyric-offset')

type OffsetTrack =
  | (Partial<Pick<TrackInfo, 'id' | 'title' | 'artist' | 'durationMs' | 'source' | 'playlistKey'>> & {
      syncPayload?: Record<string, unknown> | null
    })
  | null
  | undefined

type SongSource = LyricOffsetSource | 'none'

const SETTING_KEYS = {
  netease: 'cloudMusicOffset',
  qq: 'qqMusicOffset',
  kugou: 'kugouOffset',
  lrclib: 'lrclibOffset',
  amll_ttml: 'amllTtmlOffset',
} as const satisfies Record<LyricOffsetSource, string>

function playbackSourceOf(track: OffsetTrack): string | null {
  if (!track) return null
  if (track.source) return track.source
  const id = track.id ?? ''
  const index = id.indexOf(':')
  return index > 0 ? id.slice(0, index) : null
}

// 没记下来源的旧偏移：按曲目键的播放来源推断（netease:123 → 网易云），与改版前一致
function inferredSongSource(key: string): SongSource {
  return resolveLyricOffsetSource(null, key.slice(0, Math.max(0, key.indexOf(':')))) ?? 'none'
}

function sanitizeOffsets(parsed: unknown): Record<string, number> {
  if (!parsed || typeof parsed !== 'object') return {}
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const num = clampLyricOffsetMs(typeof value === 'number' ? value : Number(value))
    if (key && num !== 0) result[key] = num
  }
  return result
}

function readStored(): Record<string, number> {
  const preloaded = preloadedUserData()
  if (preloaded) return sanitizeOffsets(preloaded.lyricOffsets)
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitizeOffsets(JSON.parse(raw)) : {}
  } catch {
    // 本地缓存损坏时降级为空表, 不阻断偏移功能
    return {}
  }
}

function readSongSources(): Record<string, SongSource> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SOURCES_STORAGE_KEY) || '{}')
    const result: Record<string, SongSource> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === 'none' || (LYRIC_OFFSET_SOURCES as readonly unknown[]).includes(value)) {
        result[key] = value as SongSource
      }
    }
    return result
  } catch {
    return {}
  }
}

function writeSongSources(map: Record<string, SongSource>) {
  try {
    localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(map))
  } catch (error) {
    log.warn('lyric offset sources not saved:', error)
  }
}

/** 后端按整数毫秒存储，clamp 之后的值可能带小数 */
function roundedOffsets(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, Math.round(value)]))
}

function persistOffsets(command: string, args: Record<string, unknown>, map: Record<string, number>) {
  if (preloadedUserData()) {
    void persistUserData(command, args).catch((error) => {
      log.error(`${command} failed:`, error)
    })
    return
  }
  writeStored(map)
}

function writeStored(map: Record<string, number>) {
  try {
    const compact: Record<string, number> = {}
    for (const [key, value] of Object.entries(map)) {
      if (value !== 0) compact[key] = value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compact))
  } catch (error) {
    log.warn('lyric offsets not saved locally:', error)
  }
}

export const useLyricOffsetStore = defineStore('lyricOffset', () => {
  const settings = useSettingsStore()
  const offsets = ref<Record<string, number>>(readStored())
  const songSources = ref<Record<string, SongSource>>(readSongSources())

  function defaults(): Record<LyricOffsetSource, number> {
    return Object.fromEntries(
      LYRIC_OFFSET_SOURCES.map(source => [source, settings[SETTING_KEYS[source]]]),
    ) as Record<LyricOffsetSource, number>
  }

  /** 这首歌当前该用哪个来源的默认偏移：看正在显示的歌词来自哪里，不知道时按播放来源 */
  function offsetSourceFor(track: OffsetTrack): LyricOffsetSource | null {
    return resolveLyricOffsetSource(lyricSourceOf(track), playbackSourceOf(track))
  }

  function defaultOffsetMs(source: LyricOffsetSource | null): number {
    return resolveLyricDefaultOffsetMs(source, defaults())
  }

  // 逐曲用户偏移(delta): 本地覆盖优先, 其次同步载荷里的 Android 值, 否则 0
  function getUserOffsetMs(track: OffsetTrack): number {
    const key = lyricUserOffsetStorageKey(track)
    if (key && Object.prototype.hasOwnProperty.call(offsets.value, key)) {
      return offsets.value[key]
    }
    return clampLyricOffsetMs(readSyncedUserOffsetMs(track))
  }

  function setUserOffsetMs(
    track: OffsetTrack,
    value: number,
    source: LyricOffsetSource | null = offsetSourceFor(track),
  ) {
    const key = lyricUserOffsetStorageKey(track)
    if (!key) return
    const delta = clampLyricOffsetMs(value)
    const next = { ...offsets.value }
    const nextSources = { ...songSources.value }
    // delta 归零即视为"未调整", 删除键避免本地表膨胀, 也让 rebase 跳过
    if (delta === 0) {
      delete next[key]
      delete nextSources[key]
    } else {
      next[key] = delta
      nextSources[key] = source ?? 'none'
    }
    offsets.value = next
    songSources.value = nextSources
    writeSongSources(nextSources)
    persistOffsets('set_lyric_offset', { trackKey: key, offsetMs: Math.round(delta) }, next)

    // 写回 syncPayload.userLyricOffsetMs, 对齐 Android SongItem 字段, 供同步上传
    const player = usePlayerStore()
    const current = player.currentTrack
    const sameTrack = current
      && (lyricUserOffsetStorageKey(current) === key || (!!track?.id && current.id === track.id))
    if (sameTrack && current) {
      player.patchCurrentTrackSyncPayload(withUpdatedUserOffsetPayload(current.syncPayload, delta))
      void persistTrackSyncPayload(player.currentTrack)
    }
  }

  /** 有效偏移 = 当前歌词来源的默认 + 逐曲 delta, 供歌词渲染与界面显示 */
  function effectiveOffsetMs(track: OffsetTrack): number {
    return defaultOffsetMs(offsetSourceFor(track)) + getUserOffsetMs(track)
  }

  /** 按绝对值设置这首歌的偏移：存成相对当前来源默认的 delta，等于默认时即恢复跟随默认 */
  function setEffectiveOffsetMs(track: OffsetTrack, absoluteMs: number) {
    const source = offsetSourceFor(track)
    setUserOffsetMs(track, Math.round(absoluteMs) - defaultOffsetMs(source), source)
  }

  /** 同步把其它设备胜出的逐曲偏移写进了数据库，换成数据库里的新映射（不再回写） */
  function replaceFromSync(map: Record<string, number>) {
    offsets.value = sanitizeOffsets(map)
  }

  // 系统默认变化时, 对"来源匹配且已手动调过"的歌曲 rebase, 保持绝对时序不变
  function rebaseSource(source: LyricOffsetSource, prevDefault: number, newDefault: number) {
    if (prevDefault === newDefault) return
    const next = { ...offsets.value }
    let changed = false
    for (const key of Object.keys(next)) {
      const songSource = songSources.value[key] ?? inferredSongSource(key)
      const delta = next[key]
      if (!shouldRebaseLyricOffset(songSource === 'none' ? null : songSource, source, delta)) continue
      const rebased = clampLyricOffsetMs(rebaseLyricUserOffsetMs(delta, prevDefault, newDefault))
      if (rebased === 0) delete next[key]
      else next[key] = rebased
      changed = true
    }
    if (changed) {
      offsets.value = next
      persistOffsets('replace_lyric_offsets', { offsets: roundedOffsets(next) }, next)
    }
  }

  // 读入磁盘设置（hydration）时只更新基线；之后用户改默认才 rebase。
  // 守卫看 isHydrated 本身：读入的值与默认相同时不会触发变化，不能靠「第一次变化」来判断
  for (const source of LYRIC_OFFSET_SOURCES) {
    const key = SETTING_KEYS[source]
    let last = settings[key]
    watch(
      () => [settings.isHydrated, settings[key]] as const,
      ([hydrated, next], [wasHydrated]) => {
        const previous = last
        last = next
        if (hydrated && wasHydrated) rebaseSource(source, previous, next)
      },
    )
  }

  return {
    offsets,
    getUserOffsetMs,
    setUserOffsetMs,
    replaceFromSync,
    offsetSourceFor,
    defaultOffsetMs,
    effectiveOffsetMs,
    setEffectiveOffsetMs,
    rebaseSource,
  }
})
