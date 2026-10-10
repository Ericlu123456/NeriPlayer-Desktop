export interface BiliVideoSkipTarget {
  bvid: string
  cid: number
}

export interface BiliVideoSkipInterval {
  startMs: number
  endMs: number
}

export interface BiliVideoSkipRule extends BiliVideoSkipTarget {
  intervals: BiliVideoSkipInterval[]
  modifiedAt: number
  isDeleted: boolean
}

export const MAX_BILI_VIDEO_SKIP_INTERVALS = 100
export const MAX_BILI_VIDEO_SKIP_RULES = 2000
const MAX_BILI_SKIP_TIME_SECONDS = 86400
const BILI_SKIP_REWIND_TOLERANCE_MS = 1000

type SkipTrack = {
  id?: string
  source?: string
  album?: string
  syncPayload?: Record<string, unknown> | null
} | null | undefined

function payloadText(track: SkipTrack, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = track?.syncPayload?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

export function isBiliVideoSkipTrack(track: SkipTrack): boolean {
  if (!track) return false
  return track.id?.toLowerCase().startsWith('bilibili:') === true
    || track.source?.toLowerCase() === 'bilibili'
    || payloadText(track, 'channelId', 'channel_id')?.toLowerCase() === 'bilibili'
    || /^Bilibili(?:\||$)/i.test(track.album ?? '')
    || /^Bilibili(?:\||$)/i.test(payloadText(track, 'album') ?? '')
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\+?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function normalizeBiliVideoSkipTarget(target: BiliVideoSkipTarget | null | undefined): BiliVideoSkipTarget | null {
  const bvid = typeof target?.bvid === 'string' ? target.bvid.trim() : ''
  const cid = positiveInteger(target?.cid)
  return bvid && cid ? { bvid, cid } : null
}

export function biliVideoSkipTargetKey(target: BiliVideoSkipTarget): string {
  return `${target.bvid}|${target.cid}`
}

export function resolveBiliVideoSkipBvid(track: SkipTrack): string | null {
  if (!isBiliVideoSkipTrack(track)) return null
  const storedAlbum = payloadText(track, 'album')
  for (const album of [storedAlbum, track?.album]) {
    if (!/^Bilibili\|/i.test(album ?? '')) continue
    const bvid = album?.split('|')[2]?.trim()
    if (bvid) return bvid
  }
  const storedBvid = payloadText(track, 'bvid')
  if (storedBvid) return storedBvid
  const audioId = payloadText(track, 'audioId', 'audio_id')
  if (audioId && /^BV[0-9a-z]+$/i.test(audioId)) return audioId
  const id = track?.id?.replace(/^bilibili:/i, '').split(':')[0]?.trim()
  return id && /^BV[0-9a-z]+$/i.test(id) ? id : null
}

export function resolveBiliVideoSkipCid(track: SkipTrack): number | null {
  if (!isBiliVideoSkipTrack(track)) return null
  const storedCid = positiveInteger(payloadText(track, 'subAudioId', 'sub_audio_id'))
  if (storedCid) return storedCid
  for (const album of [payloadText(track, 'album'), track?.album]) {
    if (!/^Bilibili\|/i.test(album ?? '')) continue
    const cid = positiveInteger(album?.split('|')[1])
    if (cid) return cid
  }
  return null
}

export function resolveBiliVideoSkipTarget(track: SkipTrack): BiliVideoSkipTarget | null {
  const bvid = resolveBiliVideoSkipBvid(track), cid = resolveBiliVideoSkipCid(track)
  return bvid && cid ? { bvid, cid } : null
}

export function parseBiliSkipTime(value: string): number | null {
  const parts = value.trim().split(':')
  if (parts.length < 1 || parts.length > 3) return null
  if (parts.some(part => !/^[+-]?\d+$/.test(part.trim()))) return null
  const numbers = parts.map(part => Number(part.trim()))
  if (numbers.some(number => !Number.isSafeInteger(number) || number < 0)) return null
  if (numbers.length > 1 && numbers[numbers.length - 1]! > 59) return null
  if (numbers.length === 3 && numbers[1]! > 59) return null
  const seconds = numbers.reduce((total, part) => total * 60 + part, 0)
  return seconds <= MAX_BILI_SKIP_TIME_SECONDS ? seconds * 1000 : null
}

export function formatBiliSkipTime(positionMs: number): string {
  const totalSeconds = Number.isFinite(positionMs) ? Math.floor(Math.max(0, positionMs) / 1000) : 0
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const padded = (number: number) => String(number).padStart(2, '0')
  return hours > 0 ? `${padded(hours)}:${padded(minutes)}:${padded(seconds)}` : `${padded(minutes)}:${padded(seconds)}`
}

export function normalizeBiliSkipIntervals(
  intervals: readonly BiliVideoSkipInterval[],
  durationMs = 0,
): BiliVideoSkipInterval[] {
  const maxEndMs = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : Number.MAX_SAFE_INTEGER
  const sorted = intervals
    .filter(interval => interval && Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs))
    .map(interval => ({ startMs: Math.max(0, Math.round(interval.startMs)), endMs: Math.min(maxEndMs, Math.round(interval.endMs)) }))
    .filter(interval => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .slice(0, MAX_BILI_VIDEO_SKIP_INTERVALS)
  const normalized: BiliVideoSkipInterval[] = []
  for (const interval of sorted) {
    const previous = normalized[normalized.length - 1]
    if (previous && interval.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, interval.endMs)
    else normalized.push(interval)
  }
  return normalized
}

export function normalizeBiliVideoSkipRules(rules: unknown): BiliVideoSkipRule[] {
  if (!Array.isArray(rules)) return []
  const byTarget = new Map<string, BiliVideoSkipRule>()
  for (const raw of rules as BiliVideoSkipRule[]) {
    const target = normalizeBiliVideoSkipTarget(raw)
    if (!target) continue
    const rule: BiliVideoSkipRule = {
      ...target,
      intervals: raw.isDeleted === true ? [] : normalizeBiliSkipIntervals(Array.isArray(raw.intervals) ? raw.intervals : []),
      modifiedAt: Number.isFinite(raw.modifiedAt) ? Math.max(0, Math.round(raw.modifiedAt)) : 0,
      isDeleted: raw.isDeleted === true,
    }
    if (!rule.isDeleted && !rule.intervals.length) continue
    const key = biliVideoSkipTargetKey(target), previous = byTarget.get(key)
    if (!previous || rule.modifiedAt > previous.modifiedAt) byTarget.set(key, rule)
    else if (rule.modifiedAt === previous.modifiedAt) {
      if (previous.isDeleted && !rule.isDeleted) byTarget.set(key, rule)
      else if (!previous.isDeleted && !rule.isDeleted) {
        byTarget.set(key, { ...previous, intervals: normalizeBiliSkipIntervals([...previous.intervals, ...rule.intervals]) })
      }
    }
  }
  return [...byTarget.values()].sort((a, b) => (a.bvid < b.bvid ? -1 : a.bvid > b.bvid ? 1 : 0) || a.cid - b.cid).slice(0, MAX_BILI_VIDEO_SKIP_RULES)
}

export function intervalsForBiliVideoSkipPlayback(
  rules: readonly BiliVideoSkipRule[],
  target: BiliVideoSkipTarget | null,
  fallbackCid: number | null = null,
  fallbackBvid: string | null = null,
): BiliVideoSkipInterval[] {
  const normalizedTarget = normalizeBiliVideoSkipTarget(target)
  let matched: BiliVideoSkipRule | undefined
  if (normalizedTarget) {
    matched = rules.find(rule => rule.bvid === normalizedTarget.bvid && rule.cid === normalizedTarget.cid)
  } else {
    const candidates = fallbackCid !== null
      ? rules.filter(rule => fallbackCid > 0 && rule.cid === fallbackCid)
      : rules.filter(rule => !!fallbackBvid?.trim() && rule.bvid === fallbackBvid.trim())
    if (candidates.length === 1) matched = candidates[0]
  }
  return matched && !matched.isDeleted ? matched.intervals : []
}

export class BiliVideoSkipTracker {
  private skippedIntervals = new Set<string>()
  private lastPositionMs: number | null = null
  private lastIntervalsKey: string | null = null

  reset() {
    this.skippedIntervals.clear()
    this.lastPositionMs = null
    this.lastIntervalsKey = null
  }

  nextSkipPosition(intervals: readonly BiliVideoSkipInterval[], currentPositionMs: number, durationMs: number): number | null {
    const intervalsKey = JSON.stringify(intervals)
    if (this.lastIntervalsKey !== intervalsKey) {
      this.reset()
      this.lastIntervalsKey = intervalsKey
    }
    const positionMs = Math.max(0, currentPositionMs)
    if (this.lastPositionMs !== null && positionMs + BILI_SKIP_REWIND_TOLERANCE_MS < this.lastPositionMs) this.skippedIntervals.clear()
    this.lastPositionMs = positionMs
    let skipEndMs = positionMs, extendedRange: boolean
    const skippedInJump = new Set<string>()
    do {
      extendedRange = false
      for (const interval of intervals) {
        const key = `${interval.startMs}|${interval.endMs}`
        const endMs = durationMs > 0 ? Math.min(interval.endMs, durationMs) : interval.endMs
        if (this.skippedIntervals.has(key) || skippedInJump.has(key) || interval.startMs > skipEndMs || endMs <= positionMs || endMs <= interval.startMs) continue
        skippedInJump.add(key)
        if (endMs > skipEndMs) { skipEndMs = endMs; extendedRange = true }
      }
    } while (extendedRange)
    if (skipEndMs <= positionMs) return null
    for (const key of skippedInJump) this.skippedIntervals.add(key)
    return skipEndMs
  }
}
