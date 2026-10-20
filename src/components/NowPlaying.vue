<script setup lang="ts">
// 正在播放页：封面、歌词、控制栏、队列/评论/音效面板与手势都在这里。
// Now-playing page: cover, lyrics, transport, queue/comments/effects panels and gestures.
//
// 它实际上承担了“主服务”的编排职责，因此没有为了行数而强行拆分：
// 封面与歌词动画共享同一套时钟和布局测量，拆开反而会引入时序回归。
// 新增能力优先落到独立组件或 composable，只有确实共享这套时钟/布局时才加在这里。
// This component effectively acts as the app's main service, so it is not split just
// to reduce line count: cover and lyric animations share one clock and layout
// measurement, and splitting them tends to introduce timing regressions. Put new
// features in dedicated components/composables unless they genuinely share that clock.

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { usePlayerStore, displayAlbum, type AudioInfo, type LyricLine, type TrackInfo } from '@/stores/player'
import { AUDIO_EFFECT_PRESETS } from '@/modules/audioEffects/model'
import { useLikedSongsStore } from '@/stores/likedSongs'
import {
  COVER_BLUR_PX_PER_UNIT,
  LYRIC_FONT_SCALE_MAX,
  LYRIC_FONT_SCALE_MIN,
  LYRIC_FONT_SCALE_STEP,
  useSettingsStore,
} from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { useDownloadStore } from '@/stores/download'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { extractPalette, type PaletteResult } from '@/utils/paletteExtractor'
import { shouldShowDynamicBackground } from '@/utils/nowPlayingBackground'
import {
  normalizeCoverUrlForDisplay,
  normalizeProxiedCoverUrl,
  peekCoverImage,
  resolveCoverImage,
} from '@/utils/bilibiliCover'
import { clearCachedLyrics, saveCachedLyrics } from '@/modules/lyrics/lyricsCache'
import {
  toEditableLyricsText,
  toEditableTranslationText,
  toEditableRomanizationText,
  resolveStoredLyricStateFromPayload,
  resolveStoredTranslatedLyricStateFromPayload,
  resolveStoredRomanizedLyricStateFromPayload,
  withUpdatedLyricsPayload,
  mapBackendLyrics as mapBackendLyricsShared,
  mergeParsedLyricsWithTranslations,
  mergeParsedLyricsWithRomanization,
  resolveKnownNeteaseLyricSongId,
} from '@/modules/lyrics/lyricsFormat'
import { lyricMatchSourceTag, type LyricMatchResult } from '@/modules/lyrics/lyricMatch'
import {
  formatLyricOffsetMs,
  MAX_LYRIC_DEFAULT_OFFSET_MS,
  MIN_LYRIC_DEFAULT_OFFSET_MS,
  LYRIC_OFFSET_STEP_MS,
} from '@/modules/lyrics/lyricOffset'
import {
  fetchLyrics,
  fetchNeteaseRomanization,
} from '@/modules/lyrics/lyricsFetch'
import { useCurrentLyricsStore } from '@/stores/currentLyrics'
import { lyricSourceOf, rememberLyricSource } from '@/modules/lyrics/lyricSource'
import { isEditableTarget, isMacPlatform } from '@/modules/shortcuts/platform'
import {
  persistTrackSyncPayload,
  recordLyricOverride,
  withUpdatedCustomInfoPayload,
} from '@/modules/lyrics/syncTrackPayload'
import { useLyricOffsetStore } from '@/stores/lyricOffset'
import HyperBackground from './HyperBackground.vue'
import CoverBlurBackground from './CoverBlurBackground.vue'
import CommentsPanel from './CommentsPanel.vue'
import { resolveCommentTarget } from '@/modules/playback/commentTarget'
import BilibiliCoverImage from './BilibiliCoverImage.vue'
import NowPlayingContextMenu from './NowPlayingContextMenu.vue'
import WaveformSlider from './WaveformSlider.vue'
import LyricsView from './LyricsView.vue'
import QueuePanel from './QueuePanel.vue'
import AddToPlaylistDialog from './AddToPlaylistDialog.vue'
import BiliVideoSkipDialog from './BiliVideoSkipDialog.vue'
import { resolveBiliVideoSkipBvid } from '@/modules/playback/biliVideoSkip'
import ListenTogetherPanel from './ListenTogetherPanel.vue'
import EditableRangeValue from './ui/EditableRangeValue.vue'
import AudioEffectsPanel from './AudioEffectsPanel.vue'
import LyricsMatchPanel from './LyricsMatchPanel.vue'
import { wheelAdjustedVolume } from '@/utils/volume'
import { writeClipboardText } from '@/utils/clipboard'
import { playbackSessionTrackKey } from '@/modules/playback/playbackRequest'
import { createLogger } from '@/utils/logger'
import { getTrackCoverUrl } from '@/utils/trackCover'
import { summarizeLogError } from '@/utils/logSanitizer'
import { closeDesktopLyricsWindow, desktopLyricsOpen, openDesktopLyricsWindow } from '@/modules/desktopLyrics/bridge'
import { normalizeDesktopLyricsStyle } from '@/modules/desktopLyrics/style'
import { usePlaybackAudioInfoDisplay } from '@/composables/usePlaybackAudioInfoDisplay'
import {
  actualAudioBitrateLabel,
  actualAudioParameterLabels,
  canSwitchAudioQuality,
  isLocalAudioPlayback,
  resolveAudioQualityLabel,
} from '@/modules/playback/audioQualityDisplay'

const log = createLogger('now-playing')

const emit = defineEmits<{ collapse: [] }>()
const contextMenuRef = ref<InstanceType<typeof NowPlayingContextMenu> | null>(null)
const props = defineProps<{
  hideHeader?: boolean
  transitionState?: 'opening' | 'closing' | null
}>()
const player = usePlayerStore()
const likedSongs = useLikedSongsStore()
const settings = useSettingsStore()
const toast = useToastStore()
const downloadStore = useDownloadStore()
const lyricOffsetStore = useLyricOffsetStore()
const router = useRouter()
const { t } = useI18n()
async function toggleDesktopLyrics() {
  try {
    if (desktopLyricsOpen.value) {
      await closeDesktopLyricsWindow()
    } else {
      await openDesktopLyricsWindow()
      hideMoreSheet()
    }
  } catch (error) {
    log.warn('desktop lyrics window failed:', summarizeLogError(error))
    toast.error(t('player.desktop_lyrics_failed'))
  }
}

function toggleDesktopLyricsLock() {
  settings.desktopLyrics = normalizeDesktopLyricsStyle({ ...settings.desktopLyrics, locked: !settings.desktopLyrics.locked })
}
const playViewMode = ref<'cover' | 'lyrics'>('cover')
const coverLoadError = ref(false)
const coverUrl = ref('')
const showVolumeSlider = ref(false)
const showQueue = ref(false)
const showAddToPlaylist = ref(false)
const showBiliVideoSkip = ref(false)
const biliVideoSkipTrack = ref<TrackInfo | null>(null)
const canManageBiliVideoSkip = computed(() => !!player.currentTrack && !!resolveBiliVideoSkipBvid(player.currentTrack))
const showAudioFxPanel = ref(false)
const showComments = ref(false)
const commentTarget = computed(() => resolveCommentTarget(player.currentTrack))
const showSleepMenu = ref(false)
const showMoreSheet = ref(false)
const showLtPanel = ref(false)
const isTrackSwitchAnimating = ref(false)
const trackSwitchDirection = ref<'prev' | 'next' | 'neutral'>('neutral')

// Low performance mode (opt-in, off by default): with a full-screen overlay open the
// background shader, lyrics and waveform all sit underneath it, invisible yet still burning
// CPU/GPU. While the mode is off every per-frame animation keeps running unchanged.
const fullScreenOverlayOpen = computed(() =>
  showComments.value
  || showQueue.value
  || showMoreSheet.value
  || showLtPanel.value
  || showAddToPlaylist.value
  || showBiliVideoSkip.value)
const frameLoopSuspended = computed(() => settings.lowPerformanceMode && fullScreenOverlayOpen.value)
const controlFeedbackPulse = ref(0)
const lastControlDirection = ref<'prev' | 'next' | 'misc' | null>(null)
let trackSwitchAnimTimer: ReturnType<typeof setTimeout> | null = null
let controlFeedbackPulseTimer: ReturnType<typeof setTimeout> | null = null
let moreSheetSwitchTimer: ReturnType<typeof setTimeout> | null = null
let coverRenderRetryCount = 0

function coverSourceLabel(rawUrl: string): string {
  if (!rawUrl) return 'empty'
  if (rawUrl.startsWith('data:')) return `data-url(${rawUrl.length})`
  try {
    return new URL(rawUrl).hostname || 'url'
  } catch {
    return `invalid(${rawUrl.length})`
  }
}

function hideMoreSheet() {
  showMoreSheet.value = false
}

// 来源徽章（对齐 Android PlaybackSourceBadge）
const playbackSourceLabel = computed(() => {
  const id = player.currentTrack?.id || ''
  if (id.startsWith('netease:')) return t('player.source_netease')
  if (id.startsWith('qq:')) return t('player.source_qq')
  if (id.startsWith('bilibili:')) return t('player.source_bilibili')
  if (id.startsWith('youtube:')) return t('player.source_youtube')
  if (id.startsWith('local:') || player.currentTrack?.audioUrl?.startsWith('file:')) return t('player.source_local')
  return ''
})
const playbackSourceIcon = computed(() => {
  const id = player.currentTrack?.id || ''
  if (id.startsWith('netease:')) return 'netease'
  if (id.startsWith('qq:')) return 'music_note'
  if (id.startsWith('bilibili:')) return 'smart_display'
  if (id.startsWith('youtube:')) return 'play_circle'
  return 'folder'
})
const showSourceBadge = computed(() => settings.showCoverBadge && playbackSourceLabel.value !== '')
const sourceBadgeKey = computed(() => `${nowPlayingTrackKey.value}:${playbackSourceIcon.value}:${playbackSourceLabel.value || 'none'}`)

function platformLabel(source?: string) {
  switch ((source || '').toLowerCase()) {
    case 'netease': return t('player.source_netease')
    case 'qq': return t('player.source_qq')
    case 'bilibili': return t('player.source_bilibili')
    case 'youtube': return t('player.source_youtube')
    case 'lrclib': return 'LRCLIB'
    case 'local': return t('player.source_local')
    default: return source || ''
  }
}

function mapBackendLyrics(lyrics: any[]): LyricLine[] {
  return mapBackendLyricsShared(lyrics)
}

function cacheLyricsForTrack(track: TrackInfo | null | undefined, lines: LyricLine[]) {
  if (!track || lines.length === 0) return
  void saveCachedLyrics(track, lines)
}

function removeCachedLyricsForCurrentTrack() {
  if (!player.currentTrack) return
  void clearCachedLyrics(player.currentTrack)
}

/**
 * 编辑后的歌词写回 syncPayload + 本地歌单, 供同步上传 (对齐 Android)
 * nextRomanized 不传时音译保持不变；传 null 清空
 */
async function commitLyricsToTrack(
  nextLyric: string | null,
  nextTranslated: string | null,
  source?: string | null,
  nextRomanized?: string | null,
) {
  const track = player.currentTrack
  if (!track) return
  const nextPayload = withUpdatedLyricsPayload(
    track.syncPayload,
    nextLyric,
    nextTranslated,
    source ?? 'LOCAL_EDIT',
    undefined,
    nextRomanized,
  )
  // CURRENT version: 有意清空也会上传 None, 与 Android v1 一致
  nextPayload.syncMetadataVersion = 1
  delete nextPayload.sync_metadata_version
  player.patchCurrentTrackSyncPayload(nextPayload)
  const updatedTrack = player.currentTrack
  if (updatedTrack) {
    await persistTrackSyncPayload(updatedTrack)
    await recordLyricOverride(updatedTrack)
  }
}

// 歌词编辑器（对齐 Android LyricsEditorSheet：原文 / 翻译 / 音译三轨 + 匹配）
const lyricsEditorText = ref('')
const lyricsTranslationEditorText = ref('')
const lyricsRomanizationEditorText = ref('')
/** 打开编辑器时音译页的初始内容：一开始就空、用户也没动过时，应用不能把音译记成「有意清空」 */
const lyricsRomanizationEditorInitial = ref('')
let lyricsEditorSession = 0
const lyricsEditorTab = ref<'original' | 'translation' | 'romanization'>('original')
/** 从「编辑歌曲信息」进来时返回那里 */
const lyricsEditorReturnView = ref<'main' | 'editinfo'>('main')
/** 编辑器里填的是匹配来的歌词时记下来源，应用后默认偏移量按它算 */
const lyricsEditorSource = ref<string | null>(null)

function storedOrDisplayed(
  state: ReturnType<typeof resolveStoredLyricStateFromPayload>,
  lines: LyricLine[],
  exportText: (lines: LyricLine[]) => string,
) {
  // 优先使用 syncPayload 原文(保持用户编辑/YRC 源文本), 否则从当前展示行导出
  if (state.kind === 'present') return state.text
  return lines.length > 0 ? exportText(lines) : ''
}

function openLyricsEditor(returnView: 'main' | 'editinfo' = 'main') {
  const payload = player.currentTrack?.syncPayload
  const lines = displayLyrics.value
  lyricsEditorTab.value = 'original'
  lyricsEditorReturnView.value = returnView
  lyricsEditorSource.value = null
  lyricsEditorText.value = storedOrDisplayed(resolveStoredLyricStateFromPayload(payload), lines, toEditableLyricsText)
  lyricsTranslationEditorText.value = storedOrDisplayed(
    resolveStoredTranslatedLyricStateFromPayload(payload), lines, toEditableTranslationText)
  lyricsRomanizationEditorText.value = storedOrDisplayed(
    resolveStoredRomanizedLyricStateFromPayload(payload), lines, toEditableRomanizationText)
  lyricsRomanizationEditorInitial.value = lyricsRomanizationEditorText.value
  const session = ++lyricsEditorSession
  if (!lyricsRomanizationEditorText.value.trim()) void prefillEditorRomanization(session)
  goToSubView('lyrics-editor')
}

// 音译页为空时从网易云取音译填进去（Android 编辑器同样带上已加载的音译）
async function prefillEditorRomanization(session: number) {
  const track = player.currentTrack
  if (!track) return
  try {
    const text = await fetchNeteaseRomanization(track, resolveKnownNeteaseLyricSongId(track))
    const stillEditing = session === lyricsEditorSession && player.currentTrack?.id === track.id
      && moreSheetView.value === 'lyrics-editor'
    if (!text || !stillEditing || lyricsRomanizationEditorText.value.trim()) return
    lyricsRomanizationEditorText.value = text
    lyricsRomanizationEditorInitial.value = text
  } catch (error) {
    log.warn('editor romanization prefill unavailable:', summarizeLogError(error))
  }
}

function leaveLyricsEditor() {
  if (lyricsEditorReturnView.value === 'editinfo') goBackTo('editinfo')
  else goBackToMain()
}

async function parseOptionalLyricTrack(text: string, label: string): Promise<LyricLine[]> {
  if (!text) return []
  try {
    return mapBackendLyrics(await invoke<any[]>('parse_lrc_content', { content: text }))
  } catch (e) {
    log.warn(`Parse ${label} failed, applying the other tracks:`, e)
    return []
  }
}

async function applyLyricsFromEditor() {
  const text = lyricsEditorText.value.trim()
  const translationText = lyricsTranslationEditorText.value.trim()
  const romanizationText = lyricsRomanizationEditorText.value.trim()
  if (!text) {
    // 清除歌词: 本地 cache + syncPayload matched* 置空 (CURRENT 版本会同步清空)
    currentLyrics.replace([])
    removeCachedLyricsForCurrentTrack()
    await commitLyricsToTrack(null, null, 'LOCAL_EDIT', null)
    toast.success(t('player.lyrics_cleared'))
    leaveLyricsEditor()
    return
  }
  try {
    // parse_lrc_content 已走 parse_auto, 支持 YRC 逐字往返
    const parsed = await invoke<any[]>('parse_lrc_content', { content: text })
    const nextLyrics = mergeParsedLyricsWithRomanization(
      mergeParsedLyricsWithTranslations(
        mapBackendLyrics(parsed),
        await parseOptionalLyricTrack(translationText, 'translation'),
      ),
      await parseOptionalLyricTrack(romanizationText, 'romanization'),
    )
    const source = lyricsEditorSource.value ?? 'LOCAL_EDIT'
    rememberLyricSource(player.currentTrack, source)
    currentLyrics.replace(nextLyrics)
    cacheLyricsForTrack(player.currentTrack, nextLyrics)
    // 原文保留编辑器文本(YRC/LRC), 与 Android toEditableLyricsText 往返一致
    const romanizedForCommit = romanizationText
      || (lyricsRomanizationEditorInitial.value.trim() ? null : undefined)
    await commitLyricsToTrack(text, translationText || null, source, romanizedForCommit)
    toast.success(t('player.lyrics_applied'))
  } catch (e) {
    log.error('Parse lyrics failed:', e)
    toast.error(String(e))
  }
  leaveLyricsEditor()
}

// 歌词匹配（对齐 Android 编辑器「匹配」）：从编辑器进来时填回编辑器，从菜单进来时直接应用
const lyricMatchTarget = ref<'track' | 'editor'>('track')
const lyricMatchSession = ref(0)

function openLyricMatch(target: 'track' | 'editor') {
  lyricMatchTarget.value = target
  lyricMatchSession.value++
  goToSubView('lyrics-fill')
}

function leaveLyricMatch() {
  if (lyricMatchTarget.value === 'editor') goBackTo('lyrics-editor')
  else goBackToMain()
}

async function onLyricMatchPicked(result: LyricMatchResult) {
  const source = lyricMatchSourceTag(result.source)
  const lyricText = toEditableLyricsText(result.lines)
  const translationText = toEditableTranslationText(result.lines)
  const romanizationText = toEditableRomanizationText(result.lines)
  if (lyricMatchTarget.value === 'editor') {
    lyricsEditorText.value = lyricText
    lyricsTranslationEditorText.value = translationText
    // 候选没有音译时保留用户已填的音译
    if (romanizationText) lyricsRomanizationEditorText.value = romanizationText
    lyricsEditorSource.value = source
    lyricsEditorTab.value = 'original'
    toast.success(t('player.lyrics_match_filled'))
    goBackTo('lyrics-editor')
    return
  }
  try {
    rememberLyricSource(player.currentTrack, source)
    currentLyrics.replace(result.lines)
    cacheLyricsForTrack(player.currentTrack, result.lines)
    // 换了一份歌词：候选没有音译时清掉旧音译，免得挂到新歌词上
    await commitLyricsToTrack(lyricText, translationText || null, source, romanizationText || null)
    toast.success(t('player.lyrics_fill_applied'))
    goBackToMain()
  } catch (e) {
    log.error('Apply matched lyrics failed:', e)
    toast.error(String(e))
  }
}

// 「获取歌曲信息」的搜索结果自带歌词时直接解析
async function parseLyricsFromSearchResult(result: any): Promise<{
  lines: LyricLine[]
  rawLyric: string
  rawTranslated: string | null
} | null> {
  if (result?.synced_lyrics) {
    const rawLyric = String(result.synced_lyrics)
    const rawTranslated = result?.translated_lyrics ? String(result.translated_lyrics) : null
    const parsed = await invoke<any[]>('parse_lrc_content', { content: rawLyric })
    let parsedTranslations: any[] = []
    if (rawTranslated) {
      try {
        parsedTranslations = await invoke<any[]>('parse_lrc_content', { content: rawTranslated })
      } catch {}
    }
    return {
      lines: mergeParsedLyricsWithTranslations(
        mapBackendLyrics(parsed),
        mapBackendLyrics(parsedTranslations),
      ),
      rawLyric,
      rawTranslated,
    }
  }

  if (result?.plain_lyrics) {
    const rawLyric = String(result.plain_lyrics)
    const lines = rawLyric
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean)
      .map((line: string, index: number) => ({
        startMs: index * 3000,
        durationMs: 3000,
        words: [] as LyricLine['words'],
        text: line,
        translation: undefined as string | undefined,
      }))
    return { lines, rawLyric, rawTranslated: null }
  }

  return null
}

// 与桌面歌词共用同一份当前歌词
const currentLyrics = useCurrentLyricsStore()
const releaseCurrentLyrics = currentLyrics.acquire()
onUnmounted(releaseCurrentLyrics)
const isFetchingLyrics = computed(() => currentLyrics.loading)

// 歌词拖动预览状态
const previewPositionMs = ref<number | null>(null)
let previewConvergeTimer: ReturnType<typeof setTimeout> | null = null

function onSliderPreview(progress: number) {
  previewPositionMs.value = progress * player.durationMs
}

function onSliderPreviewEnd() {
  // 松手后保持预览 280ms，等待播放位置追上
  if (previewConvergeTimer) clearTimeout(previewConvergeTimer)
  previewConvergeTimer = setTimeout(() => {
    previewPositionMs.value = null
  }, 280)
}

// 从封面提取的动态颜色（归一化 RGBA）
function createDefaultExtractedColors(): [number[], number[], number[], number[], number[]] {
  return [
    [0.07, 0.27, 0.42, 1],
    [0.35, 0.24, 0.20, 1],
    [0.34, 0.12, 0.26, 1],
    [0.17, 0.14, 0.34, 1],
    [0.18, 0.34, 0.36, 1],
  ]
}

const extractedColors = ref(createDefaultExtractedColors())
const paletteResult = ref<PaletteResult | null>(null)
const PALETTE_COVER_DECODE_SIZE = 320
let paletteRequestToken = 0

function resetExtractedPalette() {
  paletteResult.value = null
  extractedColors.value = createDefaultExtractedColors()
}

// 使用 Android 同尺寸封面采样，避免小图把细节压成单色
function extractColorsFromCover(url: string): Promise<boolean> {
  const requestToken = ++paletteRequestToken
  return new Promise((resolve) => {
    const img = new Image()
    if (!url.startsWith('data:') && !url.startsWith('blob:')) {
      img.crossOrigin = 'anonymous'
    }
    img.referrerPolicy = 'no-referrer'
    img.onload = () => {
      if (requestToken !== paletteRequestToken) {
        resolve(false)
        return
      }
      try {
        const canvas = document.createElement('canvas')
        const size = PALETTE_COVER_DECODE_SIZE
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('Canvas 2D context is unavailable')
        ctx.drawImage(img, 0, 0, size, size)
        const imageData = ctx.getImageData(0, 0, size, size)

        const palette = extractPalette(imageData, 16)
        paletteResult.value = palette
        extractedColors.value = palette.shaderColors.map(
          (c) => [c[0] / 255, c[1] / 255, c[2] / 255, 1]
        ) as [number[], number[], number[], number[], number[]]
        resolve(true)
      } catch (error) {
        if (requestToken === paletteRequestToken) resetExtractedPalette()
        log.error('color extraction failed:', error)
        resolve(false)
      }
    }
    img.onerror = () => {
      if (requestToken === paletteRequestToken) {
        resetExtractedPalette()
        log.error('cover image load failed:', coverSourceLabel(url))
      }
      resolve(false)
    }
    img.src = url
  })
}

// 支持的平台封面统一走后端代理，保证显示与取色读取同一份已验证数据
watch(
  () => [
    player.hasPlaybackSession,
    player.hasPlaybackSession ? getTrackCoverUrl(player.currentTrack, 'detail') : '',
    player.hasPlaybackSession ? player.currentTrack?.id || '' : '',
  ] as const,
  async ([, rawUrl], _, onCleanup) => {
    let active = true
    onCleanup(() => { active = false })

    paletteRequestToken++
    coverRenderRetryCount = 0
    coverLoadError.value = false

    const proxiedUrl = normalizeProxiedCoverUrl(rawUrl)
    const normalizedUrl = proxiedUrl || normalizeCoverUrlForDisplay(rawUrl)
    log.info('cover resolve begin:', {
      trackId: player.currentTrack?.id,
      rawSource: coverSourceLabel(rawUrl),
      proxied: !!proxiedUrl,
      rawChars: rawUrl.length,
    })
    if (!normalizedUrl) {
      coverUrl.value = ''
      resetExtractedPalette()
      log.warn('cover resolve skipped: no usable URL')
      return
    }

    // 先显示原始地址，代理解析在后台替换，避免详情页首帧出现占位符
    const cachedUrl = proxiedUrl ? peekCoverImage(proxiedUrl) : ''
    coverUrl.value = cachedUrl || normalizedUrl
    log.info('cover fallback displayed:', {
      trackId: player.currentTrack?.id,
      source: coverSourceLabel(coverUrl.value),
      cacheHit: !!cachedUrl,
    })

    let displayUrl = cachedUrl || normalizedUrl
    if (proxiedUrl && !cachedUrl) {
      const proxyStarted = performance.now()
      try {
        displayUrl = await resolveCoverImage(proxiedUrl)
        log.info('cover proxy resolved:', {
          trackId: player.currentTrack?.id,
          elapsedMs: Math.round(performance.now() - proxyStarted),
          dataUrlChars: displayUrl.length,
        })
      } catch (error) {
        log.error('failed to resolve proxied cover:', {
          trackId: player.currentTrack?.id,
          source: coverSourceLabel(proxiedUrl),
          elapsedMs: Math.round(performance.now() - proxyStarted),
          error: summarizeLogError(error),
        })
        if (!active) return
        // 代理封面解析失败时回退到原始 URL 直接显示，而非清空封面
        displayUrl = normalizedUrl
      }
    }

    if (!active) {
      log.info('cover proxy result ignored: stale track')
      return
    }
    // 封面解析成功即显示，取色仅作背景调色板的尽力而为，不再阻塞封面渲染
    // 否则取色失败（canvas 读取异常/token 竞态）会让已解析封面永远显示不出来
    coverUrl.value = displayUrl
    coverLoadError.value = false
    log.info('cover display committed:', {
      trackId: player.currentTrack?.id,
      source: coverSourceLabel(displayUrl),
      chars: displayUrl.length,
    })
    void extractColorsFromCover(displayUrl)
  },
  { immediate: true },
)

function handleNowPlayingCoverLoad(event: Event) {
  if (!player.hasPlaybackSession) return
  const src = (event.currentTarget as HTMLImageElement).src
  coverLoadError.value = false
  log.info('cover img loaded:', {
    trackId: player.currentTrack?.id,
    source: coverSourceLabel(src),
    chars: src.length,
  })
}

async function handleNowPlayingCoverError(event: Event) {
  if (!player.hasPlaybackSession) return
  const image = event.currentTarget as HTMLImageElement
  const failedSrc = image.getAttribute('src') || image.src
  const track = player.currentTrack
  const rawUrl = getTrackCoverUrl(track, 'detail')
  const proxiedUrl = normalizeProxiedCoverUrl(rawUrl)
  if (
    !track
    || !proxiedUrl
    || failedSrc !== coverUrl.value
    || coverRenderRetryCount >= 1
  ) {
    coverLoadError.value = true
    log.warn('cover img failed:', {
      trackId: track?.id,
      source: coverSourceLabel(failedSrc),
      retry: coverRenderRetryCount,
      hasProxy: !!proxiedUrl,
    })
    return
  }

  coverRenderRetryCount++
  paletteRequestToken++
  resetExtractedPalette()
  const expectedTrackId = track.id
  const expectedRawUrl = rawUrl
  const fallbackUrl = normalizeCoverUrlForDisplay(rawUrl)
  coverLoadError.value = false
  log.warn('cover img failed, refreshing proxy:', {
    trackId: expectedTrackId,
    source: coverSourceLabel(failedSrc),
    fallbackSource: coverSourceLabel(fallbackUrl),
  })

  try {
    const refreshedUrl = await resolveCoverImage(proxiedUrl, { forceRefresh: true })
    if (
      player.currentTrack?.id !== expectedTrackId
      || getTrackCoverUrl(player.currentTrack, 'detail') !== expectedRawUrl
    ) {
      log.info('cover refresh ignored: stale track')
      return
    }

    // 重新解析成功即恢复封面显示，取色失败不应再次把封面隐藏
    coverUrl.value = refreshedUrl
    coverLoadError.value = false
    log.info('cover refresh committed:', {
      trackId: expectedTrackId,
      dataUrlChars: refreshedUrl.length,
    })
    void extractColorsFromCover(refreshedUrl)
  } catch (error) {
    log.error('failed to refresh proxied cover:', summarizeLogError(error))
    if (fallbackUrl) {
      coverUrl.value = fallbackUrl
      coverLoadError.value = false
      log.info('cover refresh fallback committed:', {
        trackId: expectedTrackId,
        source: coverSourceLabel(fallbackUrl),
      })
    } else {
      coverLoadError.value = true
    }
  }
}

function onSeek(progress: number) {
  player.seekTo(Math.round(progress * player.durationMs))
}

function onLyricSeek(ms: number) {
  player.seekTo(ms)
}

const isFavorite = computed(() => likedSongs.isTrackLiked(player.currentTrack))

async function toggleFavorite() {
  await likedSongs.toggleTrack(player.currentTrack)
}

// 睡眠定时器选项
const sleepOptions = computed(() => [
  { label: t('player.sleep_15'), value: 15 },
  { label: t('player.sleep_30'), value: 30 },
  { label: t('player.sleep_45'), value: 45 },
  { label: t('player.sleep_60'), value: 60 },
  { label: t('player.sleep_90'), value: 90 },
  { label: t('player.sleep_end_of_track'), value: -1 },
  { label: t('player.sleep_end_of_queue'), value: -2 },
])

function handleSleepOption(value: number) {
  if (value === -1) {
    player.startSleepTimerEndOfTrack()
  } else if (value === -2) {
    player.startSleepTimerEndOfQueue()
  } else {
    player.startSleepTimer(value)
  }
}

function formatSleepRemaining(seconds: number): string {
  if (seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`
}

const nowPlayingTrackKey = computed(() => (
  playbackSessionTrackKey(
    player.hasPlaybackSession,
    player.currentTrack?.playlistKey,
    player.currentTrack?.id,
  )
))
const transitionStateClass = computed(() => props.transitionState ? `np-shell--${props.transitionState}` : '')
const favoriteVisualKey = computed(() => `${nowPlayingTrackKey.value}:${isFavorite.value ? 'favorite' : 'normal'}`)
const headerAlbumKey = computed(() => `${nowPlayingTrackKey.value}:${albumName.value || 'album'}`)
const coverTransitionName = computed(() => {
  if (!isTrackSwitchAnimating.value) return 'np-cover-static'
  if (trackSwitchDirection.value === 'prev') return 'np-cover-flow-prev'
  if (trackSwitchDirection.value === 'next') return 'np-cover-flow-next'
  return 'np-cover-static'
})
const metaTransitionName = computed(() => {
  if (!isTrackSwitchAnimating.value) return 'np-meta-static'
  if (trackSwitchDirection.value === 'prev') return 'np-meta-flow-prev'
  if (trackSwitchDirection.value === 'next') return 'np-meta-flow-next'
  return 'np-meta-static'
})
const controlsPulseClass = computed(() => (
  controlFeedbackPulse.value && lastControlDirection.value === 'misc'
    ? 'np-controls--feedback'
    : ''
))
const isVisualBeatActive = computed(() => isTrackSwitchAnimating.value)
const cardCoverRef = ref<HTMLDivElement>()

function closeToolbarPopovers(except?: 'queue' | 'sleep' | 'volume' | 'audiofx' | 'add') {
  if (except !== 'queue') showQueue.value = false
  if (except !== 'sleep') showSleepMenu.value = false
  if (except !== 'volume') showVolumeSlider.value = false
  if (except !== 'audiofx') showAudioFxPanel.value = false
  if (except !== 'add') showAddToPlaylist.value = false
}

// 播放会话结束时收起所有浮层；右键菜单由子组件自行处理。
// Close every overlay when the playback session ends; the context menu is handled
// by its own component.
watch(() => player.hasPlaybackSession, (hasSession) => {
  if (hasSession) return
  closeToolbarPopovers()
  showQueue.value = false
  showMoreSheet.value = false
  showLtPanel.value = false
})

function toggleToolbarPanel(panel: 'sleep' | 'volume' | 'audiofx' | 'add') {
  const nextOpen = panel === 'sleep'
    ? !showSleepMenu.value
    : panel === 'volume'
      ? !showVolumeSlider.value
      : panel === 'audiofx'
        ? !showAudioFxPanel.value
        : !showAddToPlaylist.value

  closeToolbarPopovers(nextOpen ? panel : undefined)

  if (!nextOpen) return
  if (panel === 'sleep') showSleepMenu.value = true
  else if (panel === 'volume') showVolumeSlider.value = true
  else if (panel === 'audiofx') showAudioFxPanel.value = true
  else showAddToPlaylist.value = true
}

function triggerControlFeedbackPulse(direction: 'prev' | 'next' | 'misc' = 'misc') {
  lastControlDirection.value = direction
  controlFeedbackPulse.value = Date.now()
  if (controlFeedbackPulseTimer) clearTimeout(controlFeedbackPulseTimer)
  controlFeedbackPulseTimer = setTimeout(() => {
    controlFeedbackPulse.value = 0
    lastControlDirection.value = null
  }, 280)
}

function handlePrevClick() {
  trackSwitchDirection.value = 'prev'
  triggerControlFeedbackPulse('prev')
  player.previous()
}

function handleNextClick() {
  trackSwitchDirection.value = 'next'
  triggerControlFeedbackPulse('next')
  player.next()
}

function handleTogglePlayPause() {
  player.togglePlayPause()
}

function handleToggleShuffle() {
  triggerControlFeedbackPulse('misc')
  player.toggleShuffle()
}

function handleToggleRepeatMode() {
  triggerControlFeedbackPulse('misc')
  player.toggleRepeatMode()
}

function handleOpenQueue() {
  triggerControlFeedbackPulse('misc')
  closeToolbarPopovers('queue')
  showQueue.value = true
}

type CoverSnapshot = {
  src: string
}

/// 收起播放页时把封面地址交回 App，作为 MiniPlayer 首帧的兜底图
function getCoverSnapshot(): CoverSnapshot | null {
  const src = coverUrl.value
  return src ? { src } : null
}

// 封面加载错误时重置
watch(nowPlayingTrackKey, () => {
  coverLoadError.value = false
  closeToolbarPopovers()
  if (!controlFeedbackPulse.value || lastControlDirection.value === 'misc') {
    trackSwitchDirection.value = 'neutral'
  }
  isTrackSwitchAnimating.value = true
  if (trackSwitchAnimTimer) clearTimeout(trackSwitchAnimTimer)
  trackSwitchAnimTimer = setTimeout(() => {
    isTrackSwitchAnimating.value = false
    trackSwitchDirection.value = 'neutral'
  }, 560)
})

// 唱片旋转走 CSS 动画（合成线程），暂停时 animation-play-state 停在原角度
const coverWrapRef = ref<HTMLDivElement>()

// 逐帧变化的播放位置以读取函数交给进度条与歌词，本组件的模板不读它，播放时不会每帧整页重渲染
const readInterpolatedProgress = () => player.interpolatedProgress
const readInterpolatedPositionMs = () => player.interpolatedPositionMs
// Level and beat impulse change with the 200ms audio-level event, so they are read inside
// the background frame loop only
const readAudioLevel = () => (settings.audioReactive ? player.audioLevel : 0)
const readBeatImpulse = () => (settings.audioReactive ? player.beatImpulse : 0)

function onVolumeWheel(event: WheelEvent) {
  const next = wheelAdjustedVolume(player.volume, event.deltaY)
  if (next !== player.volume) void player.setVolume(next)
}

// 复制文本：菜单与更多面板共用；关闭菜单由调用方负责。
// Copy text shared by the context menu and the more sheet; closing the menu is the
// caller's responsibility.
async function copyText(text: string) {
  try {
    await writeClipboardText(text)
    toast.success(t('player.copied'))
  } catch {
    toast.error(t('player.copy_failed'))
  }
}

// ESC 分层关闭: 每次只收起最上层, 全部收起后才由 App 全局回退关闭本页 (对齐 Android 返回语义)
function handleEscapeLayered(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  // 输入框有焦点时交给全局逻辑先失焦
  if (isEditableTarget(event.target)) return
  if (contextMenuRef.value?.isContextMenuOpen) {
    contextMenuRef.value.closeContextMenu()
    event.preventDefault()
    return
  }
  if (showMoreSheet.value) {
    if (moreSheetView.value !== 'main') {
      goBackToMain()
    } else {
      showMoreSheet.value = false
    }
    event.preventDefault()
    return
  }
  if (showQueue.value || showSleepMenu.value || showVolumeSlider.value || showAudioFxPanel.value) {
    closeToolbarPopovers()
    event.preventDefault()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleEscapeLayered)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleEscapeLayered)
  if (trackSwitchAnimTimer) clearTimeout(trackSwitchAnimTimer)
  if (controlFeedbackPulseTimer) clearTimeout(controlFeedbackPulseTimer)
  if (moreSheetSwitchTimer) clearTimeout(moreSheetSwitchTimer)
  if (previewConvergeTimer) clearTimeout(previewConvergeTimer)
  closeToolbarPopovers()
})

defineExpose({
  toggleMore() {
    if (player.hasPlaybackSession) showMoreSheet.value = !showMoreSheet.value
  },
  getCoverSnapshot,
})

const displayLyrics = computed(() => currentLyrics.lines)

// 更多选项面板子视图
const moreSheetView = ref<
  'main' | 'offset' | 'fontsize' | 'effects' | 'search' | 'editinfo' |
  'quality' | 'lyrics-editor' | 'lyrics-fill' | 'track-detail'
>('main')
const moreSheetTransition = ref('slide-left')

function goToSubView(view: typeof moreSheetView.value) {
  moreSheetTransition.value = 'slide-left'
  moreSheetView.value = view
}

// 点击进度条旁的音质标签直接打开音质切换面板（ST-05：让该设置真实可切换而非纯展示）
function openQualitySwitcher() {
  if (!canSwitchCurrentAudioQuality.value || player.isLoadingAudio) return
  showMoreSheet.value = true
  goToSubView('quality')
}
function openBiliVideoSkip() {
  const track = player.currentTrack
  if (!track || !resolveBiliVideoSkipBvid(track)) return
  biliVideoSkipTrack.value = { ...track, syncPayload: track.syncPayload ? { ...track.syncPayload } : undefined }
  closeToolbarPopovers()
  showMoreSheet.value = false
  showBiliVideoSkip.value = true
}
function goBackToMain() {
  goBackTo('main')
}

function goBackTo(view: typeof moreSheetView.value) {
  moreSheetTransition.value = 'slide-right'
  moreSheetView.value = view
}

// 关闭更多选项面板时重置子视图
watch(showMoreSheet, (v) => { if (!v) setTimeout(() => { moreSheetView.value = 'main' }, 220) })

// 获取歌曲信息（搜索）
const searchQuery = ref('')
const searchResults = ref<any[]>([])
const isSearching = ref(false)
const infoSearchPlatform = ref<'netease' | 'bilibili' | 'youtube' | 'qq'>('netease')
const infoApplyCandidate = ref<any | null>(null)
const applyInfoFields = ref({
  title: true,
  artist: true,
  cover: true,
  lyrics: true,
})

/** 搜过之后才显示「无搜索结果」 */
const infoSearched = ref(false)
let infoSearchRequest = 0

// 打开即按当前歌名搜一次（对齐 Android），不用再手动点搜索
function openInfoSearch() {
  searchQuery.value = player.currentTrack?.title || ''
  searchResults.value = []
  infoApplyCandidate.value = null
  infoSearched.value = false
  applyInfoFields.value = { title: true, artist: true, cover: true, lyrics: true }
  goToSubView('search')
  void doSearch()
}

function selectInfoSearchPlatform(platform: typeof infoSearchPlatform.value) {
  if (infoSearchPlatform.value === platform) return
  infoSearchPlatform.value = platform
  void doSearch()
}

async function doSearch() {
  const q = searchQuery.value.trim()
  const request = ++infoSearchRequest
  searchResults.value = []
  infoApplyCandidate.value = null
  if (!q) {
    isSearching.value = false
    infoSearched.value = false
    return
  }
  isSearching.value = true
  const platform = infoSearchPlatform.value
  try {
    const results = await invoke<any[]>('search', {
      query: q,
      platform,
      includeLyrics: platform === 'qq',
    })
    if (request === infoSearchRequest) searchResults.value = results
  } catch (e) {
    log.error('Search failed:', e)
  } finally {
    if (request === infoSearchRequest) {
      isSearching.value = false
      infoSearched.value = true
    }
  }
}

const fieldPickerRef = ref<HTMLElement | null>(null)

function applySearchResult(result: any) {
  infoApplyCandidate.value = result
  applyInfoFields.value = {
    title: !!result.title,
    artist: !!result.artist,
    cover: !!(result.cover_url || result.coverUrl),
    lyrics: true,
  }
  // 字段选择面板默认可能在滚动区外, 选中后滚到可见位置
  void nextTick(() => {
    fieldPickerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

/** 歌词来源标记: 对齐 Android MusicPlatform 枚举名, 其余平台名 Android 侧解析为 null 亦无害 */
function lyricSourceForPlatform(source?: string | null): string {
  const key = String(source || '').toLowerCase()
  if (key.includes('netease')) return 'CLOUD_MUSIC'
  if (key.includes('qq')) return 'QQ_MUSIC'
  return key ? key.toUpperCase() : 'LOCAL_EDIT'
}

async function confirmApplySearchResult() {
  const result = infoApplyCandidate.value
  const track = player.currentTrack
  if (!result || !track) return
  // 首次覆盖前的原始展示信息, 供 original* 回退
  const original = {
    title: track.title || '',
    artist: track.artist || '',
    coverUrl: track.coverUrl || '',
  }
  const patch: Record<string, string> = {}
  if (applyInfoFields.value.title) patch.title = result.title || track.title || ''
  if (applyInfoFields.value.artist) patch.artist = result.artist || track.artist || ''
  if (applyInfoFields.value.cover) patch.coverUrl = result.cover_url || result.coverUrl || track.coverUrl || ''
  if (Object.keys(patch).length > 0) {
    // 展示字段与 syncPayload custom* 一起更新, 并写回本地歌单供同步上传 (对齐 Android)
    const nextPayload = withUpdatedCustomInfoPayload(
      track.syncPayload,
      {
        title: patch.title,
        artist: patch.artist,
        coverUrl: patch.coverUrl,
        matchedSongId: String(result.id || '') || undefined,
      },
      original,
    )
    player.updateCurrentTrackInfo(patch)
    player.patchCurrentTrackSyncPayload(nextPayload)
    await persistTrackSyncPayload(player.currentTrack)
  }
  if (applyInfoFields.value.lyrics) {
    try {
      const source = lyricSourceForPlatform(result.source || result.platform)
      const direct = await parseLyricsFromSearchResult(result)
      if (direct && direct.lines.length > 0) {
        rememberLyricSource(player.currentTrack, source)
        currentLyrics.replace(direct.lines)
        cacheLyricsForTrack(player.currentTrack, direct.lines)
        await commitLyricsToTrack(direct.rawLyric, direct.rawTranslated, source)
      } else {
        const idText = String(result.id || '')
        const neteaseId = idText.startsWith('netease:') ? parseInt(idText.replace('netease:', '')) : null
        const qqSongMid = idText.startsWith('qq:') ? idText.replace('qq:', '') : null
        const fetched = await fetchLyrics({
          title: result.title || player.currentTrack?.title || '',
          artist: result.artist || player.currentTrack?.artist || '',
          durationSecs: Math.floor((result.duration_ms || player.currentTrack?.durationMs || 0) / 1000),
          audioPath: null,
          neteaseId,
          qqSongMid,
          youtubeVideoId: null,
        })
        if (fetched.lines.length) {
          const nextLyrics = fetched.lines
          const actualSource = fetched.source ? lyricSourceForPlatform(fetched.source) : source
          rememberLyricSource(player.currentTrack, actualSource)
          currentLyrics.replace(nextLyrics)
          cacheLyricsForTrack(player.currentTrack, nextLyrics)
          // 兜底在线歌词同样写回 syncPayload, 否则不同步且重启即丢
          await commitLyricsToTrack(
            toEditableLyricsText(nextLyrics),
            toEditableTranslationText(nextLyrics) || null,
            actualSource,
          )
        }
      }
    } catch (e) {
      log.warn('Apply info lyrics failed:', e)
    }
  }
  toast.success(t('player.info_applied'))
  infoApplyCandidate.value = null
  goBackToMain()
}

// 编辑歌曲信息
const editTitle = ref('')
const editArtist = ref('')
const editCoverUrl = ref('')

function openEditInfo() {
  editTitle.value = player.currentTrack?.title || ''
  editArtist.value = player.currentTrack?.artist || ''
  editCoverUrl.value = player.currentTrack?.coverUrl || ''
  goToSubView('editinfo')
}

async function saveEditInfo() {
  const track = player.currentTrack
  if (!track) return
  const original = {
    title: track.title || '',
    artist: track.artist || '',
    coverUrl: track.coverUrl || '',
  }
  // 手工编辑与匹配同路: custom* 进 syncPayload 并落盘, 否则重启即丢且不同步
  const nextPayload = withUpdatedCustomInfoPayload(
    track.syncPayload,
    {
      title: editTitle.value,
      artist: editArtist.value,
      coverUrl: editCoverUrl.value,
    },
    original,
  )
  player.updateCurrentTrackInfo({
    title: editTitle.value,
    artist: editArtist.value,
    coverUrl: editCoverUrl.value,
  })
  player.patchCurrentTrackSyncPayload(nextPayload)
  await persistTrackSyncPayload(player.currentTrack)
  toast.success(t('player.info_applied'))
  goBackToMain()
}

function restoreInfo() {
  player.restoreOriginalTrackInfo()
  toast.success(t('player.info_restored'))
  goBackToMain()
}

// 音质切换
// 下面的计算属性在 setup 时就会被 watch 求值，选项表必须先于它们声明
const neteaseQualities = [
  { key: 'standard', label: 'settings.q_standard' },
  { key: 'higher', label: 'settings.q_high' },
  { key: 'exhigh', label: 'settings.q_exhigh' },
  { key: 'lossless', label: 'settings.q_lossless' },
  { key: 'hires', label: 'settings.q_hires' },
  { key: 'jyeffect', label: 'settings.q_surround' },
  { key: 'sky', label: 'settings.q_sky' },
  { key: 'jymaster', label: 'settings.q_master' },
]

const qqQualities = [
  { key: 'standard', label: 'settings.q_standard' },
  { key: 'high', label: 'settings.q_high_yt' },
  { key: 'lossless', label: 'settings.q_lossless' },
]

const youtubeQualities = [
  { key: 'low', label: 'settings.q_low' },
  { key: 'medium', label: 'settings.q_medium' },
  { key: 'high', label: 'settings.q_high_yt' },
  { key: 'very_high', label: 'settings.q_very_high' },
]

const biliQualities = [
  { key: 'low', label: 'settings.q_smooth' },
  { key: 'medium', label: 'settings.q_standard' },
  { key: 'high', label: 'settings.q_good' },
  { key: 'lossless', label: 'settings.q_lossless' },
  { key: 'hires', label: 'settings.q_hires' },
  { key: 'dolby', label: 'settings.q_dolby' },
]

const currentSource = computed(() => {
  const id = player.currentTrack?.id || ''
  if (id.startsWith('netease:')) return 'netease'
  if (id.startsWith('qq:')) return 'qq'
  if (id.startsWith('bilibili:')) return 'bilibili'
  if (id.startsWith('youtube:')) return 'youtube'
  return 'local'
})
// 音质列表按播放层报告的可选项过滤（B 站只列这条视频实际提供的音质）；只有一档时不显示切换（对齐 Android）
const switchableQualities = computed(() => {
  const all = qualityOptionsForSource(currentSource.value)
  const info = player.audioInfo
  const offered = info?.source === currentSource.value ? info.qualityOptions?.map(option => option.key) : undefined
  return offered?.length ? all.filter(option => offered.includes(option.key)) : all
})
const canSwitchCurrentAudioQuality = computed(() => canSwitchAudioQuality({
  source: currentSource.value, fromDownload: player.isPlayingFromDownload, info: player.audioInfo,
}) && switchableQualities.value.length > 1)
watch(canSwitchCurrentAudioQuality, (canSwitch) => {
  if (!canSwitch && moreSheetView.value === 'quality') goBackToMain()
})

// 当前歌词用哪个来源的默认偏移：看正在显示的歌词来自哪里（AMLL TTML、酷狗、LRCLIB…），不知道时按播放来源
const currentLyricOffsetSource = computed(() => lyricOffsetStore.offsetSourceFor(player.currentTrack))
const currentLyricDefaultOffsetMs = computed(() =>
  lyricOffsetStore.defaultOffsetMs(currentLyricOffsetSource.value),
)
// 逐曲 delta：只用来判断这首歌是否单独调过
const currentLyricUserOffsetMs = computed(() => lyricOffsetStore.getUserOffsetMs(player.currentTrack))

// 有效偏移（绝对值）：歌词渲染用它，偏移面板显示和编辑的也是它；与桌面歌词同一个算法
const currentLyricTotalOffsetMs = computed<number>({
  get: () => lyricOffsetStore.effectiveOffsetMs(player.currentTrack),
  set: value => lyricOffsetStore.setEffectiveOffsetMs(player.currentTrack, value),
})

// 滑条范围 ±5000ms，当前值越界时随之放宽（Android resolveLyricOffsetSliderRange）
const lyricOffsetSliderMin = computed(() => Math.min(MIN_LYRIC_DEFAULT_OFFSET_MS, currentLyricTotalOffsetMs.value))
const lyricOffsetSliderMax = computed(() => Math.max(MAX_LYRIC_DEFAULT_OFFSET_MS, currentLyricTotalOffsetMs.value))

function nudgeLyricOffset(steps: number) {
  currentLyricTotalOffsetMs.value += steps * LYRIC_OFFSET_STEP_MS
}

function resetLyricOffsetToDefault() {
  lyricOffsetStore.setUserOffsetMs(player.currentTrack, 0)
}

// 当前歌词来源的名字，用于「网易云 · 默认 +1000ms」；没有可调默认的来源也标出来
const currentLyricSourceLabel = computed(() => {
  if (currentLyricOffsetSource.value === 'netease' && lyricOffsetStore.offsetSourceIsGuessed(player.currentTrack)) {
    return t('player.lyric_source_unknown_as', { source: t('player.source_netease') })
  }
  switch (currentLyricOffsetSource.value) {
    case 'netease': return t('player.source_netease')
    case 'qq': return t('player.source_qq')
    case 'kugou': return t('player.lyric_source_kugou')
    case 'lrclib': return 'LRCLIB'
    case 'amll_ttml': return 'AMLL TTML'
  }
  const raw = (lyricSourceOf(player.currentTrack) ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (raw === 'youtube') return t('player.source_youtube')
  if (raw === 'local') return t('player.lyric_source_local')
  if (raw === 'localedit') return t('player.lyric_source_edited')
  return ''
})

const lyricOffsetSummary = computed(() => [formatLyricOffsetMs(currentLyricTotalOffsetMs.value), currentLyricSourceLabel.value]
  .filter(Boolean).join(' · '))

function nudgeLyricFontScale(steps: number) {
  const next = Math.round((settings.lyricFontScale + steps * LYRIC_FONT_SCALE_STEP) / LYRIC_FONT_SCALE_STEP) * LYRIC_FONT_SCALE_STEP
  settings.lyricFontScale = Math.min(LYRIC_FONT_SCALE_MAX, Math.max(LYRIC_FONT_SCALE_MIN, Number(next.toFixed(2))))
}

// 「更多」里音频效果一行直接写出当前生效的设置，都是默认时显示说明
const audioEffectsSummary = computed(() => {
  const parts: string[] = []
  if (player.playbackSpeed !== 1) parts.push(`${player.playbackSpeed.toFixed(2)}x`)
  if (player.vinylEffectEnabled) parts.push(t('player.vinyl_effect'))
  else if (player.playbackPitch !== 1) parts.push(`${t('player.pitch')} ${player.playbackPitch.toFixed(2)}x`)
  if (player.loudnessGainMb !== 0) parts.push(`+${(player.loudnessGainMb / 100).toFixed(1)}dB`)
  if (player.audioEffectsProfile.enabled) {
    const id = player.audioEffectsProfile.presetId
    parts.push(player.audioEffects.userPresets.find(preset => preset.id === id)?.name
      ?? (AUDIO_EFFECT_PRESETS.some(preset => preset.id === id) ? t(`dsp.presets.${id}`) : t('dsp.manual')))
  }
  return parts.length ? parts.join(' · ') : t('player.audio_effects_desc')
})

function openAudioEffectsSettings() {
  showAudioFxPanel.value = false
  showMoreSheet.value = false
  void router.push('/settings?section=audio_effects').then(() => emit('collapse'))
}

function openLyricsFill() {
  openLyricMatch('track')
}

const currentTrackId = computed(() => player.currentTrack?.id || '')
const currentNeteaseSongNumericId = computed(() => {
  const id = currentTrackId.value
  if (!id.startsWith('netease:')) return null
  const num = Number(id.replace('netease:', ''))
  return Number.isFinite(num) && num > 0 ? num : null
})
const currentDownloadTask = computed(() => currentTrackId.value ? downloadStore.downloading.get(currentTrackId.value) : undefined)
const currentDownloadedTrack = computed(() => currentTrackId.value ? downloadStore.getDownloadedTrack(currentTrackId.value) : undefined)
const isCurrentDownloaded = computed(() => currentTrackId.value ? downloadStore.isDownloaded(currentTrackId.value) : false)
const isCurrentDownloading = computed(() => !!currentDownloadTask.value)
const isCurrentDownloadCancellable = computed(() => {
  const status = currentDownloadTask.value?.status
  return status === 'resolving' || status === 'downloading'
})

function formatDurationMs(ms?: number) {
  if (!ms || ms <= 0) return '-'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatFileSize(bytes?: number) {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

// 歌曲详情专用: 码率/编解码/采样 等完整音频参数 (含 kbps, 与进度条纸面规格分离)
const trackDetailAudioParams = computed(() => {
  const info = player.audioInfo
  if (!info) return ''
  const local = isLocalAudioPlayback({ source: currentSource.value, fromDownload: player.isPlayingFromDownload, info })
  const parts: string[] = []
  const quality = currentAudioQualityLabel()
  if (quality) parts.push(quality)
  if (info.codec) {
    const codec = normalizeAudioDisplayToken(info.codec, local)
    if (codec && !parts.includes(codec)) parts.push(codec)
  }
  if (info.format) {
    const format = normalizeAudioDisplayToken(info.format, local)
    if (format && !parts.includes(format) && format.toLowerCase() !== (info.codec || '').toLowerCase()) {
      parts.push(format)
    }
  }
  const bitrate = actualAudioBitrateLabel(info)
  if (bitrate) parts.push(bitrate)
  for (const token of paperSpecFromAudioInfo(info, !local)) {
    if (!parts.includes(token)) parts.push(token)
  }
  return parts.join(' · ')
})

// 播放缓存 / 下载 / 在线流 三态
const trackDetailCacheStatus = computed(() => {
  if (player.isPlayingFromDownload) return t('player.cache_status_download')
  if (player.isPlayingFromCache) return t('player.cache_status_playback_cache')
  if (isRemotePlaybackSource(currentSource.value)) return t('player.cache_status_stream')
  return t('player.cache_status_local')
})

function isRemotePlaybackSource(source: string) {
  return source === 'netease' || source === 'qq' || source === 'bilibili' || source === 'youtube'
}

function downloadTaskStatusText(status?: string) {
  switch (status) {
    case 'queued': return t('download.queued')
    case 'processing': return t('download.processing')
    case 'resolving': return t('download.resolving')
    case 'downloading': return t('download.downloading')
    case 'cancelling': return t('download.cancelling')
    case 'cancelled': return t('download.cancelled')
    case 'error': return t('download.download_failed')
    case 'already_exists': return t('download.already_exists')
    default: return ''
  }
}

const downloadActionIcon = computed(() => {
  if (isCurrentDownloading.value) {
    const status = currentDownloadTask.value?.status
    if (status === 'error') return 'error'
    if (status === 'cancelled') return 'cancel'
    if (isCurrentDownloadCancellable.value) return 'cancel'
    return 'downloading'
  }
  if (isCurrentDownloaded.value) return 'refresh'
  return 'download'
})

const downloadActionLabel = computed(() => {
  if (isCurrentDownloadCancellable.value) return t('download.cancel_task')
  if (isCurrentDownloading.value) return downloadTaskStatusText(currentDownloadTask.value?.status) || t('download.downloading')
  if (isCurrentDownloaded.value) return t('download.redownload')
  return t('library.tab_downloads')
})

const downloadActionDesc = computed(() => {
  if (isCurrentDownloading.value) {
    const task = currentDownloadTask.value
    if (!task) return ''
    if (task.message) return task.message
    if (typeof task.progress === 'number') return `${task.progress}%`
    return ''
  }
  if (isCurrentDownloaded.value) return t('download.redownload_desc')
  return t('download.download_desc')
})

const downloadActionDisabled = computed(() =>
  !player.currentTrack
  || (isCurrentDownloading.value && !isCurrentDownloadCancellable.value && currentDownloadTask.value?.status !== 'error' && currentDownloadTask.value?.status !== 'cancelled')
)

const isQualitySwitching = ref(false)

async function switchQuality(key: string) {
  if (isQualitySwitching.value || !canSwitchCurrentAudioQuality.value || player.isLoadingAudio) return
  const source = currentSource.value
  const previousKey = currentQualityKey(source)
  if (!previousKey || previousKey === key) {
    showMoreSheet.value = false
    return
  }

  isQualitySwitching.value = true
  setQualityKey(source, key)
  try {
    showMoreSheet.value = false
    await player.replayWithQuality()
  } catch (e) {
    setQualityKey(source, previousKey)
    toast.error(String(e))
  } finally {
    isQualitySwitching.value = false
  }
}

function currentQualityKey(source = currentSource.value): string {
  if (source === 'netease') return settings.neteaseQuality
  if (source === 'qq') return settings.qqMusicQuality
  if (source === 'bilibili') return settings.biliQuality
  if (source === 'youtube') return settings.youtubeQuality
  return ''
}

function setQualityKey(source: string, key: string) {
  if (source === 'netease') settings.neteaseQuality = key
  else if (source === 'qq') settings.qqMusicQuality = key
  else if (source === 'bilibili') settings.biliQuality = key
  else if (source === 'youtube') settings.youtubeQuality = key
}

function qualityOptionsForSource(source: string) {
  if (source === 'netease') return neteaseQualities
  if (source === 'qq') return qqQualities
  if (source === 'bilibili') return biliQualities
  if (source === 'youtube') return youtubeQualities
  return []
}

function qualityLabelFor(source: string, key?: string) {
  if (!key || source === 'local') return ''
  const item = qualityOptionsForSource(source).find(q => q.key === key)
  return item ? t(item.label) : key
}

// 下载/重新下载歌曲
async function handleDownloadAction() {
  const track = player.currentTrack
  if (!track) return
  showMoreSheet.value = false
  if (isCurrentDownloadCancellable.value) {
    await downloadStore.cancelDownload(track.id)
    return
  }
  if (isCurrentDownloaded.value) {
    await downloadStore.redownloadTrack(track)
  } else {
    await downloadStore.downloadTrack(track)
  }
}

async function openCurrentAlbum() {
  const songId = currentNeteaseSongNumericId.value
  if (!songId) return
  try {
    const detail = await invoke<any>('get_netease_song_detail', { songId })
    const song = detail?.songs?.[0]
    const albumId = song?.al?.id || song?.album?.id
    if (!albumId) {
      toast.error(t('player.not_available'))
      return
    }
    hideMoreSheet()
    // 先收起正在播放页，再跳转专辑，避免详情盖在 NP 下面
    emit('collapse')
    await router.push({ name: 'netease-album', params: { id: String(albumId) } })
  } catch (e) {
    log.error('Open album failed:', e)
    toast.error(String(e))
  }
}

async function openCurrentArtist() {
  const songId = currentNeteaseSongNumericId.value
  if (!songId) return
  try {
    const detail = await invoke<any>('get_netease_song_detail', { songId })
    const song = detail?.songs?.[0]
    const artist = (song?.ar || []).find((a: any) => a?.id)
    if (!artist?.id) {
      toast.error(t('player.not_available'))
      return
    }
    hideMoreSheet()
    // 先收起正在播放页，再跳转歌手页，避免详情盖在 NP 下面
    emit('collapse')
    await router.push({
      name: 'netease-artist',
      params: { id: String(artist.id) },
      query: { name: artist.name || primaryArtistName.value },
    })
  } catch (e) {
    log.error('Open artist failed:', e)
    toast.error(String(e))
  }
}

function openListenTogetherFromMore() {
  hideMoreSheet()
  if (moreSheetSwitchTimer) clearTimeout(moreSheetSwitchTimer)
  moreSheetSwitchTimer = window.setTimeout(() => {
    moreSheetSwitchTimer = null
    if (!showMoreSheet.value) showLtPanel.value = true
  }, 220)
}

// 分享歌曲
async function shareSong() {
  const track = player.currentTrack
  if (!track) return
  // 构建分享文本
  let url = ''
  if (track.id.startsWith('netease:')) {
    const nid = track.id.replace('netease:', '')
    url = `https://music.163.com/song?id=${nid}`
  } else if (track.id.startsWith('bilibili:')) {
    const bid = track.id.replace('bilibili:', '')
    url = `https://www.bilibili.com/video/${bid}`
  } else if (track.id.startsWith('youtube:')) {
    const vid = track.id.replace('youtube:', '')
    url = `https://music.youtube.com/watch?v=${vid}`
  }
  const text = url
    ? `${track.title} - ${track.artist}\n${url}`
    : `${track.title} - ${track.artist}`
  try {
    await writeClipboardText(text)
    toast.success(t('player.share_copied'))
  } catch {
    toast.error(t('player.copy_failed'))
  }
  showMoreSheet.value = false
}

// 专辑名
const albumName = computed(() => {
  const album = player.currentTrack?.album || ''
  return displayAlbum(album)
})
const canViewNeteaseAlbum = computed(() => currentSource.value === 'netease' && !!albumName.value && !!currentNeteaseSongNumericId.value)

// 主歌手名 (展示用, 多歌手取第一个)
const primaryArtistName = computed(() => {
  const artist = player.currentTrack?.artist || ''
  return artist.split(/\s*[/,、·]\s*/)[0] || ''
})
const canViewNeteaseArtist = computed(() =>
  currentSource.value === 'netease' && !!primaryArtistName.value && !!currentNeteaseSongNumericId.value)

// 进度条下方音质信息（不展示 Local / download 占位）
// 参数开关统一控制文件和在线流，平台音质标签单独显示
const displayedAudioInfo = usePlaybackAudioInfoDisplay(() => ({
  info: player.audioInfo,
  fromDownload: player.isPlayingFromDownload,
  loading: player.isLoadingAudio,
  hasSession: player.hasPlaybackSession,
}))
const audioInfoParts = computed(() => {
  const info = displayedAudioInfo.value.info
  if (!info) return []
  const parts: Array<{ text: string; accent?: boolean }> = []
  if (settings.showQualitySwitch) addAudioInfoPart(parts, currentAudioQualityLabel(info, displayedAudioInfo.value.fromDownload), true)
  for (const token of actualAudioParameterLabels(info, settings)) addAudioInfoPart(parts, token)
  return parts.filter(part => !isHiddenAudioInfoToken(part.text))
})

// 音质行放不下时整项换行；正好落在换行处的分隔点隐藏，不让「·」挂在行首或行尾。
// 只隐藏不移除，占位不变，避免隐藏后空出位置又把下一项拉回上一行来回跳
const audioDetailEl = ref<HTMLElement | null>(null)
const wrappedAudioSeparators = ref<ReadonlySet<number>>(new Set())

function updateWrappedAudioSeparators() {
  const container = audioDetailEl.value
  const wrapped = new Set<number>()
  container?.querySelectorAll<HTMLElement>('.np-audio-separator').forEach((separator, index) => {
    const before = separator.previousElementSibling as HTMLElement | null
    const after = separator.nextElementSibling as HTMLElement | null
    if (before && after && Math.abs(before.offsetTop - after.offsetTop) > 2) wrapped.add(index)
  })
  const current = wrappedAudioSeparators.value
  if (wrapped.size !== current.size || [...wrapped].some(index => !current.has(index))) {
    wrappedAudioSeparators.value = wrapped
  }
}

// 放到下一帧再量：在观察回调里直接改状态会触发浏览器的 ResizeObserver 循环告警
let wrappedSeparatorsFrame = 0
const audioDetailResize = typeof ResizeObserver === 'undefined'
  ? null
  : new ResizeObserver(() => {
    cancelAnimationFrame(wrappedSeparatorsFrame)
    wrappedSeparatorsFrame = requestAnimationFrame(updateWrappedAudioSeparators)
  })
watch(audioDetailEl, (element, previous) => {
  if (previous) audioDetailResize?.unobserve(previous)
  if (element) audioDetailResize?.observe(element)
})
watch(audioInfoParts, () => { void nextTick(updateWrappedAudioSeparators) }, { flush: 'post' })
onUnmounted(() => {
  audioDetailResize?.disconnect()
  cancelAnimationFrame(wrappedSeparatorsFrame)
})

function currentAudioQualityLabel(info: AudioInfo | null = player.audioInfo, fromDownload = player.isPlayingFromDownload) {
  return resolveAudioQualityLabel({ source: currentSource.value, fromDownload, info },
    (source, key) => qualityLabelFor(source, key || currentQualityKey(source)))
}

// 文件播放只采用探测字段，避免把平台规格当成实际文件参数
function paperSpecFromAudioInfo(info: {
  sampleRateHz?: number
  bitDepth?: number
  channelCount?: number
  specLabel?: string
}, includeSpecLabel = true): string[] {
  const tokens: string[] = []
  if (info.sampleRateHz && info.sampleRateHz > 0) {
    const khz = info.sampleRateHz / 1000
    tokens.push(info.sampleRateHz % 1000 === 0
      ? `${khz.toFixed(0)} kHz`
      : `${khz.toFixed(1)} kHz`)
  }
  if (info.bitDepth && info.bitDepth > 0) tokens.push(`${info.bitDepth} bit`)
  if (!includeSpecLabel && info.channelCount && info.channelCount > 0) tokens.push(`${info.channelCount} ch`)
  // specLabel 里可能混有 kbps, 过滤掉
  if (includeSpecLabel && info.specLabel) {
    for (const part of info.specLabel.split('|').map(s => s.trim())) {
      if (!part || /kbps/i.test(part)) continue
      if (!tokens.includes(part)) tokens.push(part)
    }
  }
  return tokens
}

function addAudioInfoPart(
  parts: Array<{ text: string; accent?: boolean }>,
  value?: string,
  accent = false,
) {
  const normalized = value?.trim()
  if (!normalized) return
  if (parts.some(part => isSameAudioInfoToken(part.text, normalized))) return
  parts.push({ text: normalized, accent })
}

function normalizeAudioDisplayToken(value?: string, local = false) {
  if (!value) return ''
  const raw = value.trim()
  // 在线流的 format 常是 MIME（audio/mp4; codecs="mp4a.40.2"），按编码参数或子类型识别
  const [essence, params = ''] = raw.toLowerCase().split(';')
  const isMime = /^(audio|video)\//.test(essence)
  const lower = /codecs\s*=\s*"?([^",]+)/.exec(params)?.[1]?.trim()
    || (isMime ? essence.trim().replace(/^(audio|video)\/(x-)?/, '') : raw.toLowerCase())
  if (local && lower === 'mpeg') return 'MPEG'
  // 占位词直接丢掉
  if (isHiddenAudioInfoToken(raw)) return ''
  const tokenMap: Record<string, string> = {
    flac: 'FLAC',
    mp3: 'MP3',
    mpeg: 'MP3',
    aac: 'AAC',
    mp4a: 'AAC',
    mp4: 'MP4',
    m4a: 'M4A',
    webm: 'WebM',
    opus: 'Opus',
    ogg: 'OGG',
    vorbis: 'Vorbis',
    wav: 'WAV',
    aiff: 'AIFF',
    'ec-3': 'E-AC-3',
    eac3: 'E-AC-3',
    ac3: 'AC-3',
  }
  return tokenMap[lower] ?? tokenMap[lower.split('.')[0]] ?? (isMime ? lower.toUpperCase() : raw)
}

function isHiddenAudioInfoToken(value?: string) {
  if (!value) return true
  const lower = value.trim().toLowerCase()
  return lower === 'local'
    || lower === 'download'
    || lower === 'file'
    || lower === 'offline'
    || lower === 'downloaded'
}

function isSameAudioInfoToken(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

// AccentBackdrop 底色（对齐 Android：主色降饱和调暗后铺底）
// 强制压暗，保证白字在亮封面/浅主题下仍可读
const accentBgStyle = computed(() => {
  if (!player.hasPlaybackSession) return { background: 'rgb(18, 18, 18)' }
  const bg = paletteResult.value?.accentBg
  if (!bg) return { background: 'rgb(18, 18, 18)' }
  const [r, g, b] = bg
  const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255
  if (luma <= 0.34) {
    return { background: `rgb(${r}, ${g}, ${b})` }
  }
  // 过亮时向中性深色混合，保留色相
  const t = Math.min(1, (luma - 0.34) / 0.4)
  const mix = 0.35 + t * 0.45
  return {
    background: `rgb(${Math.round(r * (1 - mix) + 18 * mix)}, ${Math.round(g * (1 - mix) + 18 * mix)}, ${Math.round(b * (1 - mix) + 18 * mix)})`,
  }
})
const shouldRenderDynamicBackground = computed(() => shouldShowDynamicBackground(
  player.hasPlaybackSession,
  settings.dynamicBackground,
  paletteResult.value,
))

// 动态主题 CSS 变量（对齐 Android M3 动态配色）
const dynamicColorVars = computed(() => {
  if (!player.hasPlaybackSession) return {}
  const p = paletteResult.value
  if (!p) return {}
  const lv = p.lightVibrant

  // RGB -> HSL 转换
  const r = lv[0] / 255, g = lv[1] / 255, b = lv[2] / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }

  // HSL -> RGB
  const hsl2rgb = (h: number, s: number, l: number): [number, number, number] => {
    if (s === 0) return [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)]
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1
      if (t < 1/6) return p + (q - p) * 6 * t
      if (t < 1/2) return q
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const pp = 2 * l - q
    return [
      Math.round(hue2rgb(pp, q, h + 1/3) * 255),
      Math.round(hue2rgb(pp, q, h) * 255),
      Math.round(hue2rgb(pp, q, h - 1/3) * 255),
    ]
  }

  // 深色播放页使用柔和的亮强调色，避免蓝色封面生成过艳、偏暗的控件
  const primaryS = Math.min(0.65, s)
  const primaryL = 0.80
  const [pr, pg, pb] = hsl2rgb(h, primaryS, primaryL)
  const primary = `rgb(${pr}, ${pg}, ${pb})`

  // 播放按钮用更浅的同色容器，中性取色保持中性
  const pcS = Math.min(0.50, s * 0.8)
  const pcL = 0.88
  const [pcr, pcg, pcb] = hsl2rgb(h, pcS, pcL)
  const primaryContainer = `rgb(${pcr}, ${pcg}, ${pcb})`

  // 主色上文字：基于 primaryContainer 亮度选深/浅色
  const pcLuma = pcr * 0.299 + pcg * 0.587 + pcb * 0.114
  const onPrimary = pcLuma > 140 ? 'rgb(20, 18, 24)' : 'rgb(255, 255, 255)'

  return {
    '--np-primary': primary,
    '--np-on-primary': onPrimary,
    '--np-primary-container': primaryContainer,
    '--np-on-surface': 'rgba(255,255,255,1)',
    '--np-on-surface-variant': 'rgba(255,255,255,0.78)',
    '--waveform-thumb-color': primary,
  }
})

// 进度条与按钮共用强调色，避免再次压暗后在深色背景上看不清
const sliderActiveColor = computed(() => dynamicColorVars.value['--np-primary'] || '#fff')
</script>

<template>
  <div
    class="now-playing"
    :class="[
      transitionStateClass,
      {
        'np-shell--track-switching': isTrackSwitchAnimating,
        'np-shell--beat-active': isVisualBeatActive,
        'np--rounded-window': isMacPlatform,
      },
    ]"
    :style="[dynamicColorVars, { backgroundColor: accentBgStyle.background }]"
    @click="closeToolbarPopovers()"
  >
    <!-- AccentBackdrop 底色层（对齐 Android：主色降饱和+调暗） -->
    <div class="np-bg-solid" :style="accentBgStyle" />
    <!-- 动态背景：封面模糊 OR WebGL 着色器，互斥 -->
    <CoverBlurBackground
      v-if="player.hasPlaybackSession && settings.coverBlurBg"
      :cover-url="coverUrl"
      :blur-amount="settings.coverBlurAmount * COVER_BLUR_PX_PER_UNIT"
      :darken-alpha="Math.min(Math.max(settings.coverBlurDarken, 0), 0.8)"
    />
    <!-- Level and beat impulse are passed as readers: they change with the 200ms backend
         event, and binding the values directly re-rendered this component (including the
         whole more-options panel below) every 200ms. The readers return exactly the same
         values and the background frame loop still reads them per frame, so nothing about
         the rendering changes. -->
    <HyperBackground
      v-else-if="shouldRenderDynamicBackground"
      :playing="player.isPlaying"
      :low-performance="settings.lowPerformanceMode"
      :suspended="frameLoopSuspended"
      :music-level="readAudioLevel"
      :beat-impulse="readBeatImpulse"
      :colors="extractedColors"
      :is-dark="true"
      :light-offset="paletteResult?.lightOffset ?? 0"
      :saturate-offset="paletteResult?.saturateOffset ?? 0"
    />
    <div class="np-scrim" />
    <div class="np-ambient-glow" />

    <!-- 顶栏（融合模式下由 TitleBar 接管） -->
    <header v-if="!props.hideHeader" class="np-header">
      <button class="np-icon-btn" @click.stop="emit('collapse')">
        <span class="material-symbols-rounded">keyboard_arrow_down</span>
      </button>
      <div class="np-header-center">
        <span v-if="settings.showNowPlayingTitle" class="np-from-label">
          {{ player.hasPlaybackSession ? t('player.now_playing') : t('player.not_playing') }}
        </span>
        <transition name="np-header-meta-swap" mode="out-in">
          <span :key="headerAlbumKey" class="np-from-name">
            {{ player.hasPlaybackSession ? albumName : '' }}
          </span>
        </transition>
      </div>
      <button v-if="player.hasPlaybackSession" class="np-icon-btn" @click="showMoreSheet = !showMoreSheet">
        <span class="material-symbols-rounded">more_vert</span>
      </button>
      <span v-else class="np-header-spacer" aria-hidden="true" />
    </header>

    <div v-if="!player.hasPlaybackSession" class="np-empty-state">
      <span
        class="material-symbols-rounded np-empty-icon"
        :class="{ spinning: player.isLoadingAudio }"
      >{{ player.isLoadingAudio ? 'progress_activity' : 'music_off' }}</span>
      <h2>{{ player.isLoadingAudio ? t('player.loading') : t('player.not_playing') }}</h2>
    </div>

    <!-- 双栏 -->
    <div v-else class="np-body" :class="[{ 'np-body--no-header': props.hideHeader }, playViewMode === 'lyrics' ? 'np-body--lyrics-mode' : 'np-body--cover-mode']">
      <!-- 左侧：stack 固定内部高度，外层居中，切歌不上下重排 -->
      <section class="np-left">
        <div class="np-left-stack">
        <div
          ref="coverWrapRef"
          class="cover-wrap"
          :class="{
            'cover-wrap--card': settings.coverStyle === 'card',
            'cover-wrap--disc': settings.coverStyle !== 'card',
            'cover-wrap--switching': isTrackSwitchAnimating,
          }"
          @contextmenu="contextMenuRef?.openContextMenu($event, 'cover')"
        >
          <!-- Card 模式（圆角矩形，对齐 Android） -->
          <div v-if="settings.coverStyle === 'card'" ref="cardCoverRef" class="cover-card">
            <transition :name="coverTransitionName">
              <img
                v-if="coverUrl && !coverLoadError"
                :key="`cover:${nowPlayingTrackKey}`"
                :src="coverUrl"
                referrerpolicy="no-referrer"
                class="cover-card-img"
                @load="handleNowPlayingCoverLoad"
                @error="handleNowPlayingCoverError"
              />
              <span
                v-else
                :key="`placeholder:${nowPlayingTrackKey}`"
                class="material-symbols-rounded filled cover-card-placeholder"
              >music_note</span>
            </transition>
          </div>
          <!-- Disc 模式（黑胶唱片） -->
          <div v-else class="cover-disc" :class="{ 'cover-disc--spinning': player.isPlaying }">
            <div class="cover-inner">
              <transition :name="coverTransitionName">
                <img
                  v-if="coverUrl && !coverLoadError"
                  :key="`disc-cover:${nowPlayingTrackKey}`"
                  :src="coverUrl"
                  referrerpolicy="no-referrer"
                  class="cover-img"
                  @load="handleNowPlayingCoverLoad"
                  @error="handleNowPlayingCoverError"
                />
                <span
                  v-else
                  :key="`disc-placeholder:${nowPlayingTrackKey}`"
                  class="material-symbols-rounded filled cover-disc-placeholder"
                >music_note</span>
              </transition>
            </div>
          </div>
          <div v-if="settings.coverStyle !== 'card'" class="cover-disc-sheen" aria-hidden="true" />
          <!-- 来源徽章（对齐 Android PlaybackSourceBadge） -->
          <transition name="np-badge-swap" mode="out-in">
            <div
              v-if="showSourceBadge"
              :key="sourceBadgeKey"
              class="source-badge"
              :class="{ 'source-badge--disc': settings.coverStyle !== 'card' }"
            >
              <span
                v-if="playbackSourceIcon === 'netease'"
                class="source-badge-icon source-badge-icon--netease"
                aria-hidden="true"
              />
              <span v-else class="material-symbols-rounded source-badge-icon">{{ playbackSourceIcon }}</span>
              <span class="source-badge-label">{{ playbackSourceLabel }}</span>
            </div>
          </transition>
        </div>

        <!-- 固定高度叠层：切歌时不 out-in 塌高度，避免整列重居中上下跳 -->
        <div class="np-info">
          <transition :name="metaTransitionName">
            <div :key="nowPlayingTrackKey" class="np-meta">
              <h2 class="np-title" @contextmenu="contextMenuRef?.openContextMenu($event, 'title')">{{ player.currentTrack?.title || t('player.not_playing') }}</h2>
              <button type="button" class="np-artist" :disabled="Boolean(contextMenuRef?.artistLinksLoading) || !player.currentTrack?.artist.trim()" :aria-label="t('player.open_artist')" @click="contextMenuRef?.openArtistPage($event)" @contextmenu="contextMenuRef?.openContextMenu($event, 'artist')">{{ player.currentTrack?.artist || '' }}</button>
            </div>
          </transition>
        </div>

        <div class="np-slider-area">
          <WaveformSlider
            :progress="readInterpolatedProgress"
            :is-playing="player.isPlaying"
            :suspended="frameLoopSuspended"
            :active-color="sliderActiveColor"
            @seek="onSeek"
            @preview="onSliderPreview"
            @preview-end="onSliderPreviewEnd"
          />
          <div class="np-time">
            <span>{{ player.currentTimeFormatted }}</span>
            <span>{{ player.durationFormatted }}</span>
          </div>
          <!-- 音质行始终占位，空内容也保留高度 -->
          <div class="np-audio-info" :aria-busy="player.isLoadingAudio">
            <span v-if="displayedAudioInfo.fromDownload" class="np-download-chip"
              role="img"
              :title="t('player.playing_from_download')" :aria-label="t('player.playing_from_download')">
              <span class="material-symbols-rounded" aria-hidden="true">download_done</span>
            </span>
            <span v-if="audioInfoParts.length" ref="audioDetailEl" class="np-audio-detail" :class="{ separated: displayedAudioInfo.fromDownload }">
              <template v-for="(part, index) in audioInfoParts" :key="`${part.text}:${index}`">
                <span
                  class="np-audio-detail-part"
                  :class="{
                    'np-audio-detail-part--accent': part.accent,
                    'np-audio-detail-part--clickable': part.accent && canSwitchCurrentAudioQuality && !player.isLoadingAudio,
                  }"
                  :role="part.accent && canSwitchCurrentAudioQuality && !player.isLoadingAudio ? 'button' : undefined"
                  :tabindex="part.accent && canSwitchCurrentAudioQuality && !player.isLoadingAudio ? 0 : undefined"
                  @click="part.accent && !player.isLoadingAudio && openQualitySwitcher()"
                  @keydown.enter="part.accent && !player.isLoadingAudio && openQualitySwitcher()"
                >{{ part.text }}</span>
                <template v-if="index < audioInfoParts.length - 1">
                  <span
                    class="np-audio-separator"
                    :class="{ 'np-audio-separator--wrapped': wrappedAudioSeparators.has(index) }"
                    aria-hidden="true"
                  >·</span>{{ ' ' }}
                </template>
              </template>
            </span>
          </div>
        </div>

        <div
          class="np-controls"
          :class="{
            [controlsPulseClass]: !!controlFeedbackPulse,
            'np-controls--feedback-prev': lastControlDirection === 'prev',
            'np-controls--feedback-next': lastControlDirection === 'next',
          }"
        >
          <button
            class="ctrl-btn"
            :class="{ active: player.shuffleEnabled }"
            :title="t('shortcuts.shuffle')"
            :aria-label="t('shortcuts.shuffle')"
            :aria-pressed="player.shuffleEnabled"
            @click="handleToggleShuffle()"
          >
            <span class="material-symbols-rounded">shuffle</span>
          </button>

          <button
            class="ctrl-btn ctrl-btn--transport"
            :class="{ 'ctrl-btn--switching': isTrackSwitchAnimating }"
            :title="t('tray.previous')"
            :aria-label="t('tray.previous')"
            @click="handlePrevClick()"
          >
            <span class="material-symbols-rounded filled" style="font-size: 30px">skip_previous</span>
          </button>

          <!-- 播放/暂停 带动画 -->
          <button
            class="play-btn play-btn--transport"
            :class="{ 'play-btn--switching': isTrackSwitchAnimating }"
            :title="player.isPlaying ? t('tray.pause') : t('tray.play')"
            :aria-label="player.isPlaying ? t('tray.pause') : t('tray.play')"
            :disabled="player.isLoadingAudio"
            @click="handleTogglePlayPause()"
          >
            <transition name="play-icon">
              <span
                v-if="player.isLoadingAudioSlow"
                class="material-symbols-rounded spinning play-icon-inner"
                key="loading"
              >progress_activity</span>
              <span
                v-else
                class="material-symbols-rounded filled play-icon-inner"
                :key="player.isPlaying ? 'pause' : 'play'"
              >{{ player.isPlaying ? 'pause' : 'play_arrow' }}</span>
            </transition>
          </button>

          <button
            class="ctrl-btn ctrl-btn--transport"
            :class="{ 'ctrl-btn--switching': isTrackSwitchAnimating }"
            :title="t('tray.next')"
            :aria-label="t('tray.next')"
            @click="handleNextClick()"
          >
            <span class="material-symbols-rounded filled" style="font-size: 30px">skip_next</span>
          </button>

          <button
            class="ctrl-btn"
            :class="{ active: player.repeatMode !== 'off' }"
            :title="t('shortcuts.repeat')"
            :aria-label="t('shortcuts.repeat')"
            @click="handleToggleRepeatMode()"
          >
            <span class="material-symbols-rounded">{{ player.repeatMode === 'one' ? 'repeat_one' : 'repeat' }}</span>
          </button>
        </div>

        <!-- 工具栏（对齐 Android 底部：Favorite -> Queue -> Sleep -> Volume -> Speed -> Add） -->
        <div
          v-if="settings.showToolbarDock"
          class="np-toolbar"
          @click.stop
        >
          <button
            class="tool-btn tool-btn--feedback fav-btn"
            :class="{ active: isFavorite }"
            :disabled="!player.currentTrack"
            :title="t('library.liked_songs')"
            :aria-label="t('library.liked_songs')"
            :aria-pressed="isFavorite"
            @click="toggleFavorite"
          >
            <transition name="np-favorite-swap" mode="out-in">
              <span
                :key="favoriteVisualKey"
                class="material-symbols-rounded"
                :class="{ filled: isFavorite }"
              >favorite</span>
            </transition>
          </button>
          <button class="tool-btn tool-btn--feedback" :title="t('player.queue')" :aria-label="t('player.queue')" @click="handleOpenQueue()">
            <span class="material-symbols-rounded">queue_music</span>
          </button>
          <!-- 睡眠定时器 -->
          <div class="sleep-wrap">
            <button
              class="tool-btn tool-btn--feedback"
              :class="{ active: player.sleepTimerMode || showSleepMenu }"
              :title="t('player.sleep_timer')"
              :aria-label="t('player.sleep_timer')"
              @click="triggerControlFeedbackPulse(); toggleToolbarPanel('sleep')"
            >
              <span class="material-symbols-rounded">timer</span>
              <span v-if="player.sleepRemainingSeconds > 0" class="sleep-badge">
                {{ formatSleepRemaining(player.sleepRemainingSeconds) }}
              </span>
            </button>
            <Transition name="np-popover">
            <div v-if="showSleepMenu" class="sleep-popover np-floating-popover np-floating-popover--menu">
              <button
                v-for="opt in sleepOptions"
                :key="opt.value"
                class="sleep-option"
                @click="handleSleepOption(opt.value); showSleepMenu = false"
              >
                {{ opt.label }}
              </button>
              <button
                v-if="player.sleepTimerMode"
                class="sleep-option cancel"
                @click="player.cancelSleepTimer(); showSleepMenu = false"
              >
                {{ t('player.sleep_off') }}
              </button>
            </div>
            </Transition>
          </div>
          <div class="volume-wrap">
            <button
              class="tool-btn tool-btn--feedback"
              :class="{ active: showVolumeSlider }"
              :title="t('player.volume')"
              :aria-label="t('player.volume')"
              @click="triggerControlFeedbackPulse(); toggleToolbarPanel('volume')"
              @wheel.prevent="onVolumeWheel"
            >
              <span class="material-symbols-rounded">{{ player.volume === 0 ? 'volume_off' : player.volume < 0.5 ? 'volume_down' : 'volume_up' }}</span>
            </button>
            <Transition name="np-popover">
            <div v-if="showVolumeSlider" class="volume-popover np-floating-popover np-floating-popover--volume">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="1 - player.volume"
                class="volume-slider"
                @input="player.setVolume(1 - parseFloat(($event.target as HTMLInputElement).value))"
              />
              <EditableRangeValue
                :model-value="player.volume"
                class="volume-label"
                :min="0"
                :max="1"
                :step="0.01"
                :input-scale="100"
                :input-width="32"
                :range-reversed="true"
                :display-value="`${Math.round(player.volume * 100)}%`"
                input-suffix="%"
                :aria-label="t('player.volume')"
                @update:model-value="player.setVolume($event)"
              />
            </div>
            </Transition>
          </div>
          <!-- 音效 (AudioFX) -->
          <div class="speed-wrap">
            <button
              class="tool-btn tool-btn--feedback"
              :class="{ active: showAudioFxPanel || player.hasActiveEffects }"
              :title="t('player.audio_effects')"
              :aria-label="t('player.audio_effects')"
              @click="triggerControlFeedbackPulse(); toggleToolbarPanel('audiofx')"
            >
              <span class="material-symbols-rounded">tune</span>
            </button>
            <Transition name="np-popover">
              <div v-if="showAudioFxPanel" class="audiofx-popover np-floating-popover np-floating-popover--audiofx">
                <AudioEffectsPanel @details="openAudioEffectsSettings" />
              </div>
            </Transition>
          </div>
          <button
            class="tool-btn tool-btn--feedback"
            :title="t('player.add_to_playlist')"
            :aria-label="t('player.add_to_playlist')"
            @click="triggerControlFeedbackPulse(); toggleToolbarPanel('add')"
          >
            <span class="material-symbols-rounded">playlist_add</span>
          </button>
          <!-- 评论（对齐 Android：仅网易云、B 站） -->
          <button
            v-if="commentTarget"
            class="tool-btn tool-btn--feedback"
            :class="{ active: showComments }"
            :title="t('player.comments')"
            :aria-label="t('player.comments')"
            @click="triggerControlFeedbackPulse(); closeToolbarPopovers(); showComments = true"
          >
            <span class="material-symbols-rounded">chat_bubble</span>
          </button>
        </div>
        </div>
      </section>

      <!-- 右侧歌词 -->
      <section class="np-right" :class="{ 'np-right--switching': isTrackSwitchAnimating, 'np-right--beat-active': isVisualBeatActive }">
        <LyricsView
          v-if="displayLyrics.length > 0"
          :lyrics="displayLyrics"
          :current-time-ms="readInterpolatedPositionMs"
          :preview-time-ms="previewPositionMs"
          :is-playing="player.isPlaying"
          :lyric-offset-ms="currentLyricTotalOffsetMs"
          :seek-seq="player.lastSeekCommand.seq"
          :suspended="frameLoopSuspended"
          @seek="onLyricSeek"
        />
        <div v-else-if="isFetchingLyrics" class="lyrics-empty">
          <span class="material-symbols-rounded spinning" style="font-size: 36px">progress_activity</span>
          <p>{{ t('player.loading') }}</p>
        </div>
        <div v-else class="lyrics-empty">
          <span class="material-symbols-rounded" style="font-size: 36px">lyrics</span>
          <p>{{ t('player.no_lyrics') }}</p>
        </div>
      </section>
    </div>

    <!-- 播放队列面板（Teleport 到 body，避免被全屏页开合动画的 transform 包含块限制） -->
    <Teleport to="body">
      <Transition name="queue-sheet">
        <QueuePanel v-if="player.hasPlaybackSession && showQueue" @close="showQueue = false" />
      </Transition>
    </Teleport>
    <AddToPlaylistDialog v-if="player.hasPlaybackSession" v-model:open="showAddToPlaylist" :track="player.currentTrack" />
    <BiliVideoSkipDialog v-model:open="showBiliVideoSkip" :track="biliVideoSkipTrack" />
    <CommentsPanel v-model:open="showComments" :track="player.currentTrack" />
    <ListenTogetherPanel v-if="player.hasPlaybackSession" v-model:open="showLtPanel" />

    <!-- 更多选项面板（对齐 Android MoreOptionsSheet） -->
    <Teleport to="body">
      <Transition name="more-sheet">
      <div v-if="player.hasPlaybackSession && showMoreSheet" class="np-more-overlay" @click="showMoreSheet = false">
        <div class="np-more-sheet" @click.stop>

          <Transition :name="moreSheetTransition" mode="out-in">
          <div :key="moreSheetView" class="np-more-sheet-content">

          <!-- 主菜单：分组与顺序对齐 Android MoreOptionsMainContent；常用的偏移、字号直接在行内加减 -->
          <template v-if="moreSheetView === 'main'">
            <h4 class="np-more-title">{{ t('player.more_options') }}</h4>

            <!-- 歌曲信息 -->
            <div class="np-more-group">
              <button class="np-more-list-item" @click="openInfoSearch">
                <span class="material-symbols-rounded">info</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.get_info') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button class="np-more-list-item" @click="openEditInfo">
                <span class="material-symbols-rounded">edit</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.edit_info') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button v-if="commentTarget" class="np-more-list-item" @click="showMoreSheet = false; showComments = true">
                <span class="material-symbols-rounded">chat_bubble</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.comments') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
            </div>

            <!-- 播放：音质、音频效果、下载 -->
            <div class="np-more-group">
              <button v-if="canSwitchCurrentAudioQuality" class="np-more-list-item" :disabled="player.isLoadingAudio" @click="openQualitySwitcher()">
                <span class="material-symbols-rounded">music_note</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.quality_switch') }}</span>
                  <span class="np-more-list-desc">{{ currentAudioQualityLabel() || '—' }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button class="np-more-list-item" @click="goToSubView('effects')">
                <span class="material-symbols-rounded">tune</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.audio_effects') }}</span>
                  <span class="np-more-list-desc">{{ audioEffectsSummary }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button
                v-if="currentSource !== 'local'"
                class="np-more-list-item"
                :disabled="downloadActionDisabled"
                @click="handleDownloadAction"
              >
                <span class="material-symbols-rounded">{{ downloadActionIcon }}</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ downloadActionLabel }}</span>
                  <span v-if="downloadActionDesc" class="np-more-list-desc">{{ downloadActionDesc }}</span>
                </div>
              </button>
            </div>

            <!-- 歌词 -->
            <div class="np-more-group">
              <div class="np-more-list-item np-more-list-item--stepper">
                <button class="np-more-stepper-main" @click="goToSubView('offset')">
                  <span class="material-symbols-rounded">timer</span>
                  <div class="np-more-list-info">
                    <span class="np-more-list-headline">{{ t('player.lyric_offset') }}</span>
                    <span class="np-more-list-desc" :class="{ 'np-more-list-desc--custom': currentLyricUserOffsetMs !== 0 }">{{ lyricOffsetSummary }}</span>
                  </div>
                </button>
                <div class="np-more-stepper">
                  <button :title="t('player.lyric_offset_later')" :aria-label="t('player.lyric_offset_later')" @click="nudgeLyricOffset(-1)">
                    <span class="material-symbols-rounded">remove</span>
                  </button>
                  <button :title="t('player.lyric_offset_earlier')" :aria-label="t('player.lyric_offset_earlier')" @click="nudgeLyricOffset(1)">
                    <span class="material-symbols-rounded">add</span>
                  </button>
                </div>
              </div>
              <div class="np-more-list-item np-more-list-item--stepper">
                <button class="np-more-stepper-main" @click="goToSubView('fontsize')">
                  <span class="material-symbols-rounded">format_size</span>
                  <div class="np-more-list-info">
                    <span class="np-more-list-headline">{{ t('player.font_scale') }}</span>
                    <span class="np-more-list-desc">{{ Math.round(settings.lyricFontScale * 100) }}%</span>
                  </div>
                </button>
                <div class="np-more-stepper">
                  <button
                    :disabled="settings.lyricFontScale <= LYRIC_FONT_SCALE_MIN"
                    :title="t('player.font_scale_smaller')" :aria-label="t('player.font_scale_smaller')"
                    @click="nudgeLyricFontScale(-1)"
                  >
                    <span class="material-symbols-rounded">text_decrease</span>
                  </button>
                  <button
                    :disabled="settings.lyricFontScale >= LYRIC_FONT_SCALE_MAX"
                    :title="t('player.font_scale_larger')" :aria-label="t('player.font_scale_larger')"
                    @click="nudgeLyricFontScale(1)"
                  >
                    <span class="material-symbols-rounded">text_increase</span>
                  </button>
                </div>
              </div>
              <button class="np-more-list-item" :class="{ active: desktopLyricsOpen }" @click="toggleDesktopLyrics">
                <span class="material-symbols-rounded">picture_in_picture_alt</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.desktop_lyrics') }}</span>
                </div>
                <span v-if="desktopLyricsOpen" class="material-symbols-rounded np-more-list-check">check</span>
              </button>
              <button v-if="desktopLyricsOpen" class="np-more-list-item" @click="toggleDesktopLyricsLock">
                <span class="material-symbols-rounded">{{ settings.desktopLyrics.locked ? 'lock' : 'lock_open' }}</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t(settings.desktopLyrics.locked ? 'desktop_lyrics.unlock' : 'desktop_lyrics.lock') }}</span>
                </div>
              </button>
              <button class="np-more-list-item" @click="openLyricsFill">
                <span class="material-symbols-rounded">lyrics</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.lyrics_fill') }}</span>
                  <span class="np-more-list-desc">{{ t('player.lyrics_fill_desc') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button class="np-more-list-item" @click="openLyricsEditor()">
                <span class="material-symbols-rounded">edit_note</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.lyrics_editor') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
            </div>

            <!-- 浏览与分享 -->
            <div class="np-more-group">
              <button v-if="canManageBiliVideoSkip" class="np-more-list-item" @click="openBiliVideoSkip">
                <span class="material-symbols-rounded">skip_next</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.bili_skip_manage') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button v-if="canViewNeteaseAlbum" class="np-more-list-item" @click="openCurrentAlbum">
                <span class="material-symbols-rounded">library_music</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.view_album', { name: albumName }) }}</span>
                </div>
              </button>
              <button v-if="canViewNeteaseArtist" class="np-more-list-item" @click="openCurrentArtist">
                <span class="material-symbols-rounded">artist</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.view_artist', { name: primaryArtistName }) }}</span>
                </div>
              </button>
              <button class="np-more-list-item" @click="shareSong">
                <span class="material-symbols-rounded">share</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.share') }}</span>
                </div>
              </button>
              <button class="np-more-list-item" @click="openListenTogetherFromMore">
                <span class="material-symbols-rounded">headphones</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('listen_together.title') }}</span>
                  <span class="np-more-list-desc">{{ t('listen_together.entry_desc') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
              <button class="np-more-list-item" @click="goToSubView('track-detail')">
                <span class="material-symbols-rounded">article</span>
                <div class="np-more-list-info">
                  <span class="np-more-list-headline">{{ t('player.track_detail') }}</span>
                  <span class="np-more-list-desc">{{ t('player.track_detail_desc') }}</span>
                </div>
                <span class="material-symbols-rounded np-more-chevron">chevron_right</span>
              </button>
            </div>
          </template>

          <!-- 子视图：歌词偏移（显示与编辑的都是实际生效的偏移） -->
          <template v-else-if="moreSheetView === 'offset'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.lyric_offset') }}</h4>
            </div>
            <div class="np-more-item">
              <div class="np-more-hint">
                {{ currentLyricSourceLabel
                  ? t('player.lyric_offset_default_of', { source: currentLyricSourceLabel, value: formatLyricOffsetMs(currentLyricDefaultOffsetMs) })
                  : t('player.lyric_offset_default', { value: formatLyricOffsetMs(currentLyricDefaultOffsetMs) }) }}
              </div>
              <div class="np-more-row">
                <button class="np-more-step-btn" :title="t('player.lyric_offset_later')" :aria-label="t('player.lyric_offset_later')" @click="nudgeLyricOffset(-1)">
                  <span class="material-symbols-rounded">remove</span>
                </button>
                <input type="range"
                  :min="lyricOffsetSliderMin" :max="lyricOffsetSliderMax" :step="LYRIC_OFFSET_STEP_MS"
                  :value="currentLyricTotalOffsetMs"
                  class="np-more-slider"
                  :aria-label="t('player.lyric_offset')"
                  @input="currentLyricTotalOffsetMs = parseInt(($event.target as HTMLInputElement).value)"
                />
                <button class="np-more-step-btn" :title="t('player.lyric_offset_earlier')" :aria-label="t('player.lyric_offset_earlier')" @click="nudgeLyricOffset(1)">
                  <span class="material-symbols-rounded">add</span>
                </button>
                <EditableRangeValue
                  v-model="currentLyricTotalOffsetMs"
                  class="np-offset-value"
                  :class="{ positive: currentLyricTotalOffsetMs > 0, negative: currentLyricTotalOffsetMs < 0 }"
                  :min="lyricOffsetSliderMin"
                  :max="lyricOffsetSliderMax"
                  :step="LYRIC_OFFSET_STEP_MS"
                  :display-value="formatLyricOffsetMs(currentLyricTotalOffsetMs)"
                  input-suffix="ms"
                  :aria-label="t('player.lyric_offset')"
                />
              </div>
              <p class="np-more-hint np-more-hint--below">{{ t('player.lyric_offset_hint') }}</p>
              <button v-if="currentLyricUserOffsetMs !== 0" class="np-more-text-btn" @click="resetLyricOffsetToDefault">
                <span class="material-symbols-rounded">restart_alt</span>
                {{ t('player.lyric_offset_reset', { value: formatLyricOffsetMs(currentLyricDefaultOffsetMs) }) }}
              </button>
            </div>
          </template>

          <!-- 子视图：字号 -->
          <template v-else-if="moreSheetView === 'fontsize'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.font_scale') }}</h4>
            </div>
            <div class="np-more-item">
              <div class="np-more-row">
                <input type="range" :min="LYRIC_FONT_SCALE_MIN" :max="LYRIC_FONT_SCALE_MAX" :step="LYRIC_FONT_SCALE_STEP"
                  :value="settings.lyricFontScale"
                  class="np-more-slider"
                  :aria-label="t('player.font_scale')"
                  @input="settings.lyricFontScale = parseFloat(($event.target as HTMLInputElement).value)"
                />
                <EditableRangeValue
                  v-model="settings.lyricFontScale"
                  class="np-offset-value"
                  :min="LYRIC_FONT_SCALE_MIN"
                  :max="LYRIC_FONT_SCALE_MAX"
                  :step="LYRIC_FONT_SCALE_STEP"
                  :input-scale="100"
                  :display-value="`${Math.round(settings.lyricFontScale * 100)}%`"
                  input-suffix="%"
                  :aria-label="t('player.font_scale')"
                />
              </div>
              <p class="np-more-preview" :style="{ fontSize: `${24 * settings.lyricFontScale}px` }">
                {{ t('player.font_preview') }}
              </p>
            </div>
          </template>

          <!-- 子视图：音频效果，与工具栏的音效弹层是同一个面板 -->
          <template v-else-if="moreSheetView === 'effects'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.audio_effects') }}</h4>
            </div>
            <AudioEffectsPanel class="np-more-effects" @details="openAudioEffectsSettings" />
          </template>

          <!-- 子视图：获取歌曲信息 -->
          <template v-else-if="moreSheetView === 'search'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.get_info') }}</h4>
            </div>
            <div class="np-more-search-bar">
              <input
                v-model="searchQuery"
                class="np-more-input"
                :placeholder="t('player.search_song')"
                @keydown.enter="doSearch"
              />
              <button class="np-more-search-btn" @click="doSearch" :disabled="isSearching">
                <span class="material-symbols-rounded">search</span>
              </button>
            </div>
            <div class="np-more-segmented platform">
              <button
                :class="{ active: infoSearchPlatform === 'netease' }"
                @click="selectInfoSearchPlatform('netease')"
              >
                {{ t('player.source_netease') }}
              </button>
              <button
                :class="{ active: infoSearchPlatform === 'qq' }"
                @click="selectInfoSearchPlatform('qq')"
              >
                {{ t('player.source_qq') }}
              </button>
              <button
                :class="{ active: infoSearchPlatform === 'bilibili' }"
                @click="selectInfoSearchPlatform('bilibili')"
              >
                Bilibili
              </button>
              <button
                :class="{ active: infoSearchPlatform === 'youtube' }"
                @click="selectInfoSearchPlatform('youtube')"
              >
                YouTube
              </button>
            </div>
            <div v-if="isSearching" class="np-more-status">{{ t('player.searching') }}</div>
            <div v-else-if="infoSearched && searchResults.length === 0" class="np-more-status">{{ t('player.no_results') }}</div>
            <div class="np-more-search-results" :class="{ compact: !!infoApplyCandidate }">
              <button
                v-for="(r, ri) in searchResults"
                :key="ri"
                class="np-more-search-item"
                :class="{ active: infoApplyCandidate === r }"
                @click="applySearchResult(r)"
              >
                <BilibiliCoverImage :src="r.cover_url" class="np-more-search-cover"><span class="np-more-search-cover np-more-search-cover-fallback material-symbols-rounded filled">music_note</span></BilibiliCoverImage>
                <div class="np-more-search-info">
                  <span class="np-more-search-title">{{ r.title }}</span>
                  <span class="np-more-search-artist">{{ r.artist }}</span>
                </div>
                <span class="np-more-search-source">{{ platformLabel(r.source) }}</span>
              </button>
            </div>
            <div v-if="infoApplyCandidate" ref="fieldPickerRef" class="np-more-field-picker">
              <div class="np-more-candidate-preview">
                <BilibiliCoverImage
                  v-if="infoApplyCandidate.cover_url || infoApplyCandidate.coverUrl"
                  :src="infoApplyCandidate.cover_url || infoApplyCandidate.coverUrl"
                  class="np-more-candidate-cover"
                />
                <div class="np-more-search-info">
                  <span class="np-more-search-title">{{ infoApplyCandidate.title }}</span>
                  <span class="np-more-search-artist">{{ infoApplyCandidate.artist }}</span>
                </div>
              </div>
              <div class="np-more-field-title">{{ t('player.fill_fields_title') }}</div>
              <div class="np-more-field-options">
                <label class="np-more-chip">
                  <input v-model="applyInfoFields.title" type="checkbox" />
                  <span>{{ t('player.song_title') }}</span>
                </label>
                <label class="np-more-chip">
                  <input v-model="applyInfoFields.artist" type="checkbox" />
                  <span>{{ t('player.artist_name') }}</span>
                </label>
                <label class="np-more-chip">
                  <input v-model="applyInfoFields.cover" type="checkbox" />
                  <span>{{ t('player.fill_field_cover') }}</span>
                </label>
                <label class="np-more-chip">
                  <input v-model="applyInfoFields.lyrics" type="checkbox" />
                  <span>{{ t('player.fill_field_lyrics') }}</span>
                </label>
              </div>
              <div class="np-more-form-actions compact">
                <button class="np-more-form-btn primary" @click="confirmApplySearchResult">
                  <span class="material-symbols-rounded">check</span>
                  {{ t('player.apply_selection') }}
                </button>
                <button class="np-more-form-btn" @click="infoApplyCandidate = null">
                  {{ t('common.cancel') }}
                </button>
              </div>
            </div>
          </template>

          <!-- 子视图：编辑歌曲信息 -->
          <template v-else-if="moreSheetView === 'editinfo'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.edit_info') }}</h4>
            </div>
            <div class="np-more-form">
              <label class="np-more-form-label">{{ t('player.song_title') }}</label>
              <input v-model="editTitle" class="np-more-input" />

              <label class="np-more-form-label">{{ t('player.artist_name') }}</label>
              <input v-model="editArtist" class="np-more-input" />

              <label class="np-more-form-label">{{ t('player.cover_url_label') }}</label>
              <input v-model="editCoverUrl" class="np-more-input" />

              <!-- 对齐 Android：歌曲信息里直接进歌词编辑 -->
              <div class="np-more-form-actions">
                <button class="np-more-form-btn" @click="openLyricsEditor('editinfo')">
                  <span class="material-symbols-rounded">edit_note</span>
                  {{ t('player.edit_lyrics') }}
                </button>
              </div>

              <div class="np-more-form-actions">
                <button class="np-more-form-btn primary" @click="saveEditInfo">
                  <span class="material-symbols-rounded">check</span>
                  {{ t('common.save') }}
                </button>
                <button v-if="player.hasOriginalTrackInfo()" class="np-more-form-btn" @click="restoreInfo">
                  <span class="material-symbols-rounded">restore</span>
                  {{ t('player.restore_original') }}
                </button>
              </div>
            </div>
          </template>

          <!-- 子视图：歌曲详情 -->
          <template v-else-if="moreSheetView === 'track-detail'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.track_detail') }}</h4>
            </div>
            <div class="np-track-detail-card">
              <div class="np-track-detail-hero">
                <img
                  v-if="coverUrl && !coverLoadError"
                  :src="coverUrl"
                  class="np-track-detail-cover"
                  referrerpolicy="no-referrer"
                  @error="handleNowPlayingCoverError"
                />
                <span v-else class="np-track-detail-cover np-track-detail-cover-fallback material-symbols-rounded filled">music_note</span>
                <div class="np-track-detail-heading">
                  <strong>{{ player.currentTrack?.title || '-' }}</strong>
                  <span>{{ player.currentTrack?.artist || '-' }}</span>
                </div>
              </div>

              <button class="np-track-detail-row copyable" @click="copyText(player.currentTrack?.id || '')">
                <span>{{ t('player.track_detail_id') }}</span>
                <strong>{{ player.currentTrack?.id || '-' }}</strong>
              </button>
              <button class="np-track-detail-row copyable" @click="copyText(player.currentTrack?.title || '')">
                <span>{{ t('player.track_detail_title') }}</span>
                <strong>{{ player.currentTrack?.title || '-' }}</strong>
              </button>
              <button class="np-track-detail-row copyable" @click="copyText(player.currentTrack?.artist || '')">
                <span>{{ t('player.track_detail_artist') }}</span>
                <strong>{{ player.currentTrack?.artist || '-' }}</strong>
              </button>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_album') }}</span>
                <strong>{{ albumName || '-' }}</strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_source') }}</span>
                <strong>{{ playbackSourceLabel || platformLabel(currentSource) || '-' }}</strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_duration') }}</span>
                <strong>{{ formatDurationMs(player.currentTrack?.durationMs || player.durationMs) }}</strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_audio_params') }}</span>
                <strong>{{ trackDetailAudioParams || '-' }}</strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_bitrate') }}</span>
                <strong>
                  {{ actualAudioBitrateLabel(player.audioInfo) || '-' }}
                </strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_cache_status') }}</span>
                <strong>{{ trackDetailCacheStatus }}</strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_local_download_play') }}</span>
                <strong>{{ player.isPlayingFromDownload ? t('player.yes') : t('player.no') }}</strong>
              </div>
              <div class="np-track-detail-row">
                <span>{{ t('player.track_detail_download_status') }}</span>
                <strong>
                  {{ currentDownloadTask
                    ? downloadTaskStatusText(currentDownloadTask.status)
                    : (isCurrentDownloaded ? t('download.downloaded') : t('download.not_downloaded')) }}
                </strong>
              </div>
              <div v-if="currentDownloadedTrack" class="np-track-detail-row">
                <span>{{ t('player.track_detail_file_size') }}</span>
                <strong>{{ formatFileSize(currentDownloadedTrack.fileSize) }}</strong>
              </div>
              <button class="np-more-form-btn primary np-track-detail-share" @click="shareSong">
                <span class="material-symbols-rounded">share</span>
                {{ t('player.copy_share_info') }}
              </button>
            </div>
          </template>

          <!-- 子视图：音质切换 -->
          <template v-else-if="moreSheetView === 'quality'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="goBackToMain()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.quality_switch') }}</h4>
            </div>
            <div v-if="canSwitchCurrentAudioQuality" class="np-more-quality-list">
              <button
                v-for="q in switchableQualities"
                :key="q.key"
                class="np-more-quality-item"
                :class="{ active: currentQualityKey() === q.key }"
                :disabled="isQualitySwitching"
                @click="switchQuality(q.key)"
              >
                <span>{{ t(q.label) }}</span>
                <span
                  v-if="currentQualityKey() === q.key"
                  class="material-symbols-rounded"
                  style="font-size: 18px"
                >check</span>
              </button>
              <div v-if="isQualitySwitching" class="np-more-status">{{ t('player.quality_changing') }}</div>
            </div>
            <div v-else class="np-more-status">{{ t('player.not_available') }}</div>
          </template>

          <!-- 子视图：歌词编辑器（对齐 Android LyricsEditorSheet） -->
          <template v-else-if="moreSheetView === 'lyrics-editor'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="leaveLyricsEditor()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t('player.lyrics_editor') }}</h4>
              <button class="np-more-header-action" @click="openLyricMatch('editor')">
                <span class="material-symbols-rounded">manage_search</span>
                {{ t('player.lyrics_match_action') }}
              </button>
            </div>
            <div class="np-lyrics-editor">
              <div class="np-more-segmented">
                <button
                  :class="{ active: lyricsEditorTab === 'original' }"
                  @click="lyricsEditorTab = 'original'"
                >
                  {{ t('player.lyrics_editor_original') }}
                </button>
                <button
                  :class="{ active: lyricsEditorTab === 'translation' }"
                  @click="lyricsEditorTab = 'translation'"
                >
                  {{ t('player.lyrics_editor_translation') }}
                </button>
                <button
                  :class="{ active: lyricsEditorTab === 'romanization' }"
                  @click="lyricsEditorTab = 'romanization'"
                >
                  {{ t('player.lyrics_editor_romanization') }}
                </button>
              </div>
              <textarea
                v-if="lyricsEditorTab === 'original'"
                v-model="lyricsEditorText"
                class="np-lyrics-textarea"
                :placeholder="t('player.lyrics_editor_placeholder')"
                spellcheck="false"
              />
              <textarea
                v-else-if="lyricsEditorTab === 'translation'"
                v-model="lyricsTranslationEditorText"
                class="np-lyrics-textarea"
                :placeholder="t('player.lyrics_translation_placeholder')"
                spellcheck="false"
              />
              <textarea
                v-else
                v-model="lyricsRomanizationEditorText"
                class="np-lyrics-textarea"
                :placeholder="t('player.lyrics_romanization_placeholder')"
                spellcheck="false"
              />
              <div class="np-more-form-actions">
                <button class="np-more-form-btn primary" @click="applyLyricsFromEditor">
                  <span class="material-symbols-rounded">check</span>
                  {{ t('player.lyrics_apply') }}
                </button>
                <button class="np-more-form-btn" @click="lyricsEditorText = ''; lyricsTranslationEditorText = ''; lyricsRomanizationEditorText = ''; applyLyricsFromEditor()">
                  <span class="material-symbols-rounded">clear_all</span>
                  {{ t('player.lyrics_clear') }}
                </button>
              </div>
            </div>
          </template>

          <!-- 子视图：歌词匹配（对齐 Android 歌词编辑器「匹配」；从菜单进来时直接应用） -->
          <template v-else-if="moreSheetView === 'lyrics-fill'">
            <div class="np-more-sub-header">
              <button class="np-more-back" @click="leaveLyricMatch()">
                <span class="material-symbols-rounded">arrow_back</span>
              </button>
              <h4 class="np-more-title">{{ t(lyricMatchTarget === 'editor' ? 'player.lyrics_match' : 'player.lyrics_fill') }}</h4>
            </div>
            <LyricsMatchPanel
              v-if="player.currentTrack"
              :key="`${lyricMatchSession}:${player.currentTrack.id}`"
              :title="player.currentTrack.title"
              :artist="player.currentTrack.artist"
              :album="player.currentTrack.album"
              :duration-ms="player.currentTrack.durationMs || 0"
              :playback-source="currentSource"
              :prefer-word-timed="settings.preferWordTimedLyrics"
              :apply-label="t(lyricMatchTarget === 'editor' ? 'player.lyrics_match_fill_editor' : 'player.lyrics_match_apply')"
              @pick="onLyricMatchPicked"
            />
          </template>

          </div>
          </Transition>

        </div>
      </div>
      </Transition>
    </Teleport>

    <NowPlayingContextMenu
      ref="contextMenuRef"
      :cover-url="coverUrl"
      :copy-text="copyText"
      @collapse="emit('collapse')"
      @add-to-playlist="showAddToPlaylist = true"
      @share="shareSong"
    />
  </div>
</template>

<style scoped lang="scss" src="./NowPlaying.scss"></style>

<style lang="scss" src="./NowPlaying.global.scss"></style>
