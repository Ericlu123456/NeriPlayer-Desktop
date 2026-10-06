export interface AudioQualityState {
  source: string
  fromDownload: boolean
  info: {
    source?: string
    qualityKey?: string
    qualityLabel?: string
  } | null
}

export function isLocalAudioPlayback(state: AudioQualityState): boolean {
  return state.fromDownload || state.source === 'local' || state.info?.source === 'local'
}

export function canSwitchAudioQuality(state: AudioQualityState): boolean {
  return !isLocalAudioPlayback(state) && ['netease', 'qq', 'bilibili', 'youtube'].includes(state.source)
}

export function resolveAudioQualityLabel(
  state: AudioQualityState,
  resolveFallback: (source: string, key?: string) => string,
): string {
  if (isLocalAudioPlayback(state)) return ''
  const info = state.info
  const labeled = info?.qualityLabel?.trim()
  if (labeled && !/kbps/i.test(labeled) && labeled !== info?.qualityKey) return labeled
  return resolveFallback(info?.source || state.source, info?.qualityKey)
}

export function actualAudioBitrateLabel(info: { bitrate?: number } | null): string {
  const bitrate = info?.bitrate
  return typeof bitrate === 'number' && Number.isFinite(bitrate) && bitrate > 0
    ? `${Math.round(bitrate)} kbps`
    : ''
}
