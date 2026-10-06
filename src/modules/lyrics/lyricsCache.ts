import type { LyricLine, TrackInfo } from '@/stores/player'
import { getCachedValue, removeCachedValue, setCachedValue } from '@/utils/persistentCache'
import { lyricsIdentity } from './lyricsRequest'

// 键带版本：跨平台优先 LRCLIB+时长硬门槛后，旧的错误同名歌词缓存一律失效
const LYRICS_CACHE_VERSION = 'v3'
const LYRICS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const LYRICS_CACHE_MAX_ENTRIES = 500
const LYRICS_CACHE_MAX_BYTES = 32 * 1024 * 1024

function cacheKey(track: TrackInfo) {
  return `${LYRICS_CACHE_VERSION}:${lyricsIdentity(track)}`
}

function normalizeLyricLine(line: LyricLine): LyricLine {
  return {
    startMs: Number(line.startMs || 0),
    durationMs: Number(line.durationMs || 0),
    words: Array.isArray(line.words)
      ? line.words.map(word => ({
        startMs: Number(word.startMs || 0),
        durationMs: Number(word.durationMs || 0),
        text: String(word.text || ''),
      }))
      : [],
    text: String(line.text || ''),
    translation: line.translation || undefined,
    roman: line.roman || undefined,
  }
}

function hasVisibleLyric(lines: LyricLine[]): boolean {
  return lines.some(line =>
    line.text.trim().length > 0
    || line.words.some(word => word.text.trim().length > 0),
  )
}

export async function getCachedLyrics(track: TrackInfo): Promise<LyricLine[] | null> {
  const cached = await getCachedValue<LyricLine[]>('lyrics', cacheKey(track), LYRICS_CACHE_MAX_AGE_MS)
  if (!Array.isArray(cached)) return null

  const lines = cached.map(normalizeLyricLine)
  return hasVisibleLyric(lines) ? lines : null
}

export async function saveCachedLyrics(track: TrackInfo, lines: LyricLine[]) {
  const normalized = lines.map(normalizeLyricLine)
  if (!hasVisibleLyric(normalized)) {
    await clearCachedLyrics(track)
    return
  }

  await setCachedValue('lyrics', cacheKey(track), normalized, {
    maxAgeMs: LYRICS_CACHE_MAX_AGE_MS,
    maxEntries: LYRICS_CACHE_MAX_ENTRIES,
    maxBytes: LYRICS_CACHE_MAX_BYTES,
  })
}

export async function clearCachedLyrics(track: TrackInfo) {
  await removeCachedValue('lyrics', cacheKey(track))
}
