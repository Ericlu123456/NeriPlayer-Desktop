<script setup lang="ts">
import { writeClipboardText } from '@/utils/clipboard'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import type { TrackInfo } from '@/stores/player'
import { useAuthStore } from '@/stores/auth'
import { useToastStore } from '@/stores/toast'
import { resolveCommentTarget, type CommentTarget } from '@/modules/playback/commentTarget'
import { useEscapeClose } from '@/composables/useEscapeClose'
import type { ContextMenuActionItem } from '@/utils/contextMenu'
import BilibiliCoverImage from '@/components/BilibiliCoverImage.vue'
import ContextMenu from '@/components/ui/ContextMenu.vue'

/// 评论（对齐 Android CommentSheet）：网易云歌曲评论与 B 站视频评论，YouTube / 本地没有评论入口
const props = defineProps<{ open: boolean; track: TrackInfo | null }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const { t, locale } = useI18n()
const auth = useAuthStore()
const toast = useToastStore()

interface CommentQuote { user_name: string; content: string | null }
interface CommentEmote { placeholder: string; url: string }
interface CommentImage { url: string; width: number; height: number }

interface CommentItem {
  id: string
  user_name: string
  avatar_url: string | null
  user_level: number | null
  content: string
  time_ms: number
  like_count: number
  liked: boolean
  reply_count: number | null
  quotes: CommentQuote[]
  preview_replies: CommentItem[]
  emotes: CommentEmote[]
  images: CommentImage[]
}

interface CommentPage {
  items: CommentItem[]
  total: number
  has_more: boolean
  cursor: string | null
}

type FailureReason = 'permission' | 'not_found' | 'closed' | 'server' | 'verification' | 'api'

interface CommentActionResult {
  ok: boolean
  code: number | null
  reason: FailureReason | null
}

type CommentSort = 'hot' | 'newest' | 'recommended'

interface ReplyThread {
  items: CommentItem[]
  cursor: string | null
  hasMore: boolean
  loading: boolean
  expanded: boolean
  failed: boolean
}

interface ReplyTarget {
  commentId: string
  rootId: string
  userName: string
}

type SendStatus =
  | { kind: 'success' }
  | { kind: 'uncertain' }
  | { kind: 'failure'; reason: FailureReason | null; code: number | null }

const PAGE_SIZE = 20
/** 各平台单条评论长度上限（对齐 Android commentLengthLimit） */
const LENGTH_LIMIT: Record<CommentTarget['platform'], number> = { netease: 140, bilibili: 1000 }

const target = computed(() => resolveCommentTarget(props.track))
const sorts = computed<CommentSort[]>(() => target.value?.platform === 'netease' ? ['hot', 'newest', 'recommended'] : ['hot', 'newest'])
const sort = ref<CommentSort>('hot')
/** 切换排序时新结果出来前保留旧列表（对齐 Android pendingSort），失败可继续浏览 */
const pendingSort = ref<CommentSort | null>(null)
const items = ref<CommentItem[]>([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const loadingMore = ref(false)
const loadMoreFailed = ref(false)
const failed = ref(false)
const threads = ref<Record<string, ReplyThread>>({})
const likingIds = ref<Set<string>>(new Set())
let page = 1
let cursor: string | null = null
let requestSeq = 0
let loadedKey = ''

const draft = ref('')
const replyTarget = ref<ReplyTarget | null>(null)
const sending = ref(false)
const sendStatus = ref<SendStatus | null>(null)
const draftInput = ref<HTMLTextAreaElement | null>(null)
let draftTargetKey = ''

const bodyEl = ref<HTMLElement | null>(null)

function targetKey(): string {
  return target.value ? `${target.value.platform}:${target.value.target}` : ''
}

const lengthLimit = computed(() => target.value ? LENGTH_LIMIT[target.value.platform] : 0)
const draftLength = computed(() => draft.value.length)
const overLimit = computed(() => draftLength.value > lengthLimit.value)
const loggedIn = computed(() => {
  if (!target.value) return false
  return target.value.platform === 'netease' ? auth.netease.loggedIn : auth.bilibili.loggedIn
})
const busy = computed(() => loading.value || refreshing.value || loadingMore.value || pendingSort.value !== null)
const canSend = computed(() =>
  !!target.value && loggedIn.value && !sending.value && !busy.value && !failed.value
  && draft.value.trim().length > 0 && !overLimit.value,
)
const likeEnabled = computed(() => !busy.value && !sending.value)

const isOpen = () => props.open
useEscapeClose(isOpen, () => emit('update:open', false))

// ---------- 加载 ----------

async function loadFirstPage(nextSort: CommentSort, mode: 'reset' | 'sort' | 'refresh') {
  const current = target.value
  if (!current) return
  const requestId = ++requestSeq
  failed.value = false
  loadMoreFailed.value = false
  loadingMore.value = false
  if (mode === 'reset') {
    items.value = []
    threads.value = {}
    total.value = 0
    hasMore.value = false
    loading.value = true
  } else if (mode === 'sort') {
    pendingSort.value = nextSort
  } else {
    refreshing.value = true
  }
  try {
    const result = await invoke<CommentPage>('get_comments', { ...current, sort: nextSort, page: 1, cursor: null })
    if (requestId !== requestSeq) return
    sort.value = nextSort
    items.value = dedupe(result.items)
    threads.value = {}
    total.value = result.total
    hasMore.value = result.has_more
    page = 1
    cursor = result.cursor
    loadedKey = `${targetKey()}:${nextSort}`
    if (mode !== 'refresh') void nextTick(() => bodyEl.value?.scrollTo({ top: 0 }))
  } catch {
    if (requestId !== requestSeq) return
    if (mode === 'reset' || !items.value.length) failed.value = true
    else toast.error(t('player.comments_reload_failed'))
  } finally {
    if (requestId === requestSeq) {
      loading.value = false
      refreshing.value = false
      pendingSort.value = null
    }
  }
}

async function loadMore() {
  const current = target.value
  if (!current || !hasMore.value || busy.value || loadMoreFailed.value) return
  const requestId = requestSeq
  loadingMore.value = true
  try {
    const result = await invoke<CommentPage>('get_comments', { ...current, sort: sort.value, page: page + 1, cursor })
    if (requestId !== requestSeq) return
    page += 1
    cursor = result.cursor
    const seen = new Set(items.value.map(item => item.id))
    items.value = [...items.value, ...result.items.filter(item => !seen.has(item.id))]
    hasMore.value = result.has_more
  } catch {
    if (requestId === requestSeq) loadMoreFailed.value = true
  } finally {
    if (requestId === requestSeq) loadingMore.value = false
  }
}

function retryLoadMore() {
  loadMoreFailed.value = false
  void loadMore()
}

function selectSort(option: CommentSort) {
  if (option === (pendingSort.value ?? sort.value) || sending.value) return
  void loadFirstPage(option, items.value.length ? 'sort' : 'reset')
}

function refresh() {
  if (busy.value || sending.value) return
  void loadFirstPage(sort.value, items.value.length ? 'refresh' : 'reset')
}

function dedupe(list: CommentItem[]): CommentItem[] {
  const seen = new Set<string>()
  return list.filter(item => !seen.has(item.id) && !!seen.add(item.id))
}

// ---------- 楼中楼 ----------

/** 预览回复已经覆盖全部回复时不需要「展开」，只有还有没露出来的回复才给入口 */
function hasHiddenReplies(comment: CommentItem): boolean {
  return (comment.reply_count ?? 0) > comment.preview_replies.length
}

function replyCountLabel(comment: CommentItem): string {
  return t('player.comments_replies', { count: formatCount(comment.reply_count ?? comment.preview_replies.length) })
}

/** 展开过的楼层显示完整楼中楼（收起时保留内容让收起动画有东西可收），否则平铺预览回复 */
function visibleReplies(comment: CommentItem): CommentItem[] {
  const thread = threads.value[comment.id]
  if (!thread) return comment.preview_replies
  return thread.items.length || !thread.loading ? thread.items : comment.preview_replies
}

function repliesOpen(comment: CommentItem): boolean {
  const thread = threads.value[comment.id]
  return thread ? thread.expanded : comment.preview_replies.length > 0
}

function updateThread(rootId: string, patch: Partial<ReplyThread>) {
  const thread = threads.value[rootId]
  if (thread) threads.value = { ...threads.value, [rootId]: { ...thread, ...patch } }
}

function toggleReplies(comment: CommentItem) {
  const thread = threads.value[comment.id]
  if (!thread) {
    void loadReplies(comment.id)
    return
  }
  updateThread(comment.id, { expanded: !thread.expanded })
}

async function loadReplies(rootId: string) {
  const current = target.value
  if (!current) return
  const thread = threads.value[rootId]
    ?? { items: [], cursor: null, hasMore: true, loading: false, expanded: true, failed: false }
  if (thread.loading || !thread.hasMore) return
  const requestId = requestSeq
  threads.value = { ...threads.value, [rootId]: { ...thread, expanded: true, loading: true, failed: false } }
  try {
    const result = await invoke<CommentPage>('get_comment_replies', { ...current, commentId: rootId, cursor: thread.cursor })
    if (requestId !== requestSeq) return
    const previous = threads.value[rootId]
    if (!previous) return
    const seen = new Set(previous.items.map(item => item.id))
    const merged = [...previous.items, ...result.items.filter(item => !seen.has(item.id))]
    updateThread(rootId, {
      items: merged,
      cursor: result.cursor,
      hasMore: result.has_more && !!result.cursor && merged.length > previous.items.length,
      loading: false,
    })
    // 楼中楼总数比列表里的回复数更新，用它回写，避免「N 条回复」与实际不符
    if (result.total) {
      items.value = items.value.map(item => item.id === rootId ? { ...item, reply_count: result.total } : item)
    }
  } catch {
    if (requestId === requestSeq) updateThread(rootId, { loading: false, failed: true })
  }
}

function retryReplies(rootId: string) {
  updateThread(rootId, { failed: false })
  void loadReplies(rootId)
}

// ---------- 点赞 ----------

function applyLike(list: CommentItem[], id: string, liked: boolean): CommentItem[] {
  return list.map((item) => {
    if (item.id === id) {
      return { ...item, liked, like_count: Math.max(0, item.like_count + (liked ? 1 : -1)) }
    }
    if (item.preview_replies.some(reply => reply.id === id)) {
      return { ...item, preview_replies: applyLike(item.preview_replies, id, liked) }
    }
    return item
  })
}

async function toggleLike(comment: CommentItem) {
  const current = target.value
  if (!current || !likeEnabled.value || likingIds.value.has(comment.id)) return
  if (!loggedIn.value) {
    toast.error(t('player.comments_like_login_required'))
    return
  }
  const liked = !comment.liked
  const requestId = requestSeq
  likingIds.value = new Set(likingIds.value).add(comment.id)
  try {
    const result = await invoke<CommentActionResult>('set_comment_liked', { ...current, commentId: comment.id, liked })
    if (requestId !== requestSeq) return
    if (result.ok) {
      items.value = applyLike(items.value, comment.id, liked)
      threads.value = Object.fromEntries(Object.entries(threads.value).map(([rootId, thread]) => [
        rootId,
        thread.items.some(item => item.id === comment.id) ? { ...thread, items: applyLike(thread.items, comment.id, liked) } : thread,
      ]))
    } else {
      toast.error(withCode(likeFailureText(result.reason), result.code))
    }
  } catch {
    if (requestId === requestSeq) toast.error(t('player.comments_like_failed'))
  } finally {
    const next = new Set(likingIds.value)
    next.delete(comment.id)
    likingIds.value = next
  }
}

function likeFailureText(reason: FailureReason | null): string {
  if (reason === 'permission') return t('player.comments_like_login_required')
  if (reason === 'verification') return t('player.comments_verification_failed')
  if (reason === 'closed') return t('player.comments_closed')
  return t('player.comments_like_failed')
}

// ---------- 发表 ----------

function startReply(comment: CommentItem, rootId: string) {
  if (sending.value) return
  replyTarget.value = { commentId: comment.id, rootId, userName: displayName(comment) }
  sendStatus.value = null
  void nextTick(() => draftInput.value?.focus())
}

function cancelReply() {
  if (sending.value) return
  replyTarget.value = null
  sendStatus.value = null
}

async function sendComment() {
  const current = target.value
  if (!current || !canSend.value) return
  const content = draft.value.trim()
  const reply = replyTarget.value
  const requestId = requestSeq
  sending.value = true
  sendStatus.value = null
  try {
    const result = await invoke<CommentActionResult>('send_comment', {
      ...current,
      content,
      rootId: reply?.rootId ?? null,
      replyToId: reply?.commentId ?? null,
    })
    if (requestId !== requestSeq) return
    if (!result.ok) {
      sendStatus.value = { kind: 'failure', reason: result.reason, code: result.code }
      return
    }
    draft.value = ''
    replyTarget.value = null
    sendStatus.value = { kind: 'success' }
    sending.value = false
    if (!reply) {
      // 一级评论按最新排序刷新才能马上看到自己发的（对齐 Android sendComment）
      if (sort.value === 'newest') refresh()
      else selectSort('newest')
    } else {
      const { [reply.rootId]: _, ...rest } = threads.value
      threads.value = rest
      void loadReplies(reply.rootId)
    }
  } catch {
    // 网络层失败时评论可能已经发出，保留草稿让用户刷新核对，不自动重发
    if (requestId === requestSeq) sendStatus.value = { kind: 'uncertain' }
  } finally {
    sending.value = false
  }
}

const sendStatusText = computed(() => {
  const status = sendStatus.value
  if (!status) return ''
  if (status.kind === 'success') return t('player.comments_send_success')
  if (status.kind === 'uncertain') return t('player.comments_send_uncertain')
  const message = status.reason === 'permission' ? t('player.comments_send_login_required')
    : status.reason === 'verification' ? t('player.comments_verification_failed')
      : status.reason === 'closed' ? t('player.comments_closed')
        : t('player.comments_send_failed')
  return withCode(message, status.code)
})

function onDraftKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendComment()
  }
}

function onDraftInput() {
  if (sendStatus.value) sendStatus.value = null
  autoGrow()
}

function autoGrow() {
  const el = draftInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
}

watch(draft, () => void nextTick(autoGrow))

function withCode(message: string, code: number | null | undefined): string {
  return code === null || code === undefined ? message : t('player.comments_error_code', { message, code })
}

// ---------- 正文 / 配图 ----------

type Segment = { kind: 'text'; text: string } | { kind: 'emote'; emote: CommentEmote }

/**
 * Splits a comment body on its emote placeholders (matching Android's
 * splitCommentContent): longer placeholders win and unmatched text is kept as-is.
 *
 * The template calls this per comment, and every page change replaces `items`, which
 * re-renders the whole column: without a cache each page rescanned every comment loaded so
 * far character by character (O(loaded comments squared)). A comment's body and emotes are
 * never mutated in place, so caching per comment object is safe.
 */
const segmentCache = new WeakMap<CommentItem, Segment[]>()
function segments(comment: CommentItem): Segment[] {
  const cached = segmentCache.get(comment)
  if (cached) return cached
  const candidates = [...new Map(comment.emotes.filter(emote => emote.placeholder).map(emote => [emote.placeholder, emote])).values()]
    .sort((a, b) => b.placeholder.length - a.placeholder.length)
  if (!candidates.length) {
    const plain: Segment[] = [{ kind: 'text', text: comment.content }]
    segmentCache.set(comment, plain)
    return plain
  }
  const result: Segment[] = []
  let pending = ''
  let index = 0
  const content = comment.content
  while (index < content.length) {
    const matched = candidates.find(emote => content.startsWith(emote.placeholder, index))
    if (!matched) {
      pending += content[index]
      index += 1
      continue
    }
    if (pending) result.push({ kind: 'text', text: pending })
    pending = ''
    result.push({ kind: 'emote', emote: matched })
    index += matched.placeholder.length
  }
  if (pending) result.push({ kind: 'text', text: pending })
  segmentCache.set(comment, result)
  return result
}

function singleImageStyle(image: CommentImage) {
  const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 1
  return { aspectRatio: String(Math.max(ratio, 0.6)) }
}

const preview = ref<{ images: CommentImage[]; index: number } | null>(null)
useEscapeClose(() => preview.value !== null, () => { preview.value = null })

function openPreview(images: CommentImage[], index: number) {
  preview.value = { images, index }
}

function stepPreview(delta: number) {
  const current = preview.value
  if (!current) return
  preview.value = { ...current, index: (current.index + delta + current.images.length) % current.images.length }
}

// ---------- 右键菜单 ----------

const menu = ref<{ open: boolean; x: number; y: number; comment: CommentItem | null; rootId: string }>({
  open: false, x: 0, y: 0, comment: null, rootId: '',
})
const menuItems = computed<ContextMenuActionItem[]>(() => [
  { id: 'copy', label: t('player.comments_copy'), icon: 'content_copy' },
  { id: 'reply', label: t('player.comments_reply'), icon: 'reply', disabled: !loggedIn.value || sending.value },
])

function openMenu(event: MouseEvent, comment: CommentItem, rootId: string) {
  event.preventDefault()
  menu.value = { open: true, x: event.clientX, y: event.clientY, comment, rootId }
}

async function onMenuClick(item: ContextMenuActionItem) {
  const comment = menu.value.comment
  if (!comment) return
  if (item.id === 'copy') {
    try {
      await writeClipboardText(comment.content)
      toast.success(t('player.comments_copied'))
    } catch {
      toast.error(t('player.comments_copy_failed'))
    }
  } else if (item.id === 'reply') {
    startReply(comment, menu.value.rootId)
  }
}

// ---------- 格式化 ----------

function displayName(comment: CommentItem): string {
  return comment.user_name.trim() || t('player.comments_anonymous')
}

const timeFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'short', day: 'numeric' }))
function formatTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return t('recent.just_now')
  if (diff < 3_600_000) return t('recent.minutes_ago', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('recent.hours_ago', { count: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return t('recent.days_ago', { count: Math.floor(diff / 86_400_000) })
  return timeFormatter.value.format(new Date(ms))
}

const compactNumber = computed(() => new Intl.NumberFormat(locale.value, { notation: 'compact', maximumFractionDigits: 1 }))
function formatCount(value: number): string {
  return value > 0 ? compactNumber.value.format(value) : ''
}

// ---------- 生命周期 ----------

// 打开时才拉取；同一首、同一排序重新打开直接复用
watch(() => [props.open, targetKey()] as const, ([open, key]) => {
  if (key !== draftTargetKey) {
    draftTargetKey = key
    draft.value = ''
    replyTarget.value = null
    sendStatus.value = null
  }
  if (!open || !target.value) return
  if (!sorts.value.includes(sort.value)) sort.value = 'hot'
  if (`${key}:${sort.value}` !== loadedKey || failed.value) void loadFirstPage(sort.value, 'reset')
}, { immediate: true })

watch(() => props.open, (open) => {
  if (!open) {
    menu.value.open = false
    preview.value = null
  }
})

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
watch(sentinel, (element) => {
  observer?.disconnect()
  if (!element) return
  observer = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) void loadMore()
  }, { root: bodyEl.value, rootMargin: '400px 0px' })
  observer.observe(element)
})
onBeforeUnmount(() => observer?.disconnect())

/** 首屏 / 翻页新进来的评论按批内序号错开入场，翻页时不会整页一起闪 */
function enterDelay(index: number): string {
  return `${Math.min(index % PAGE_SIZE, 8) * 28}ms`
}
</script>

<template>
  <Teleport to="body">
    <Transition name="comments-sheet">
      <div v-if="open" class="comments-overlay" @click.self="emit('update:open', false)">
        <aside class="comments-panel" role="dialog" :aria-label="t('player.comments')">
          <header class="comments-header">
            <div class="comments-heading">
              <h3>{{ t('player.comments') }}</h3>
              <Transition name="comments-fade">
                <span v-if="total" :key="total" class="comments-total">{{ t('player.comments_total', { count: formatCount(total) || total }) }}</span>
              </Transition>
            </div>
            <button
              v-if="target"
              class="comments-icon-btn"
              :class="{ spinning: refreshing }"
              :disabled="busy || sending"
              :title="t('player.comments_refresh')"
              :aria-label="t('player.comments_refresh')"
              @click="refresh"
            >
              <span class="material-symbols-rounded">refresh</span>
            </button>
            <button class="comments-icon-btn" :aria-label="t('common.close')" @click="emit('update:open', false)">
              <span class="material-symbols-rounded">close</span>
            </button>
          </header>
          <p v-if="track" class="comments-track">{{ track.title }}<span v-if="track.artist"> · {{ track.artist }}</span></p>

          <div v-if="target" class="comments-sorts" role="tablist">
            <button
              v-for="option in sorts"
              :key="option"
              role="tab"
              :aria-selected="(pendingSort ?? sort) === option"
              class="comments-sort"
              :class="{ active: (pendingSort ?? sort) === option }"
              :disabled="sending"
              @click="selectSort(option)"
            >
              <span v-if="pendingSort === option" class="material-symbols-rounded spinning small">progress_activity</span>
              {{ t(`player.comments_${option}`) }}
            </button>
          </div>
          <div class="comments-progress" :class="{ active: pendingSort !== null || refreshing }" />

          <div ref="bodyEl" class="comments-body" :class="{ dimmed: pendingSort !== null }">
            <Transition name="comments-fade" mode="out-in">
              <div v-if="!target" key="unavailable" class="comments-state">
                <span class="material-symbols-rounded">comments_disabled</span>
                <p>{{ t('player.comments_unavailable') }}</p>
              </div>
              <div v-else-if="loading" key="loading" class="comments-state">
                <span class="material-symbols-rounded spinning">progress_activity</span>
              </div>
              <div v-else-if="failed" key="failed" class="comments-state">
                <span class="material-symbols-rounded">wifi_off</span>
                <p>{{ t('player.comments_failed') }}</p>
                <button class="comments-pill-btn" @click="loadFirstPage(sort, 'reset')">{{ t('player.retry') }}</button>
              </div>
              <div v-else-if="!items.length" key="empty" class="comments-state">
                <span class="material-symbols-rounded">chat_bubble</span>
                <p>{{ t('player.comments_empty') }}</p>
              </div>
              <div v-else :key="`list:${loadedKey}`" class="comments-list">
                <TransitionGroup name="comment" appear>
                  <article
                    v-for="(comment, index) in items"
                    :key="comment.id"
                    class="comment"
                    :style="{ '--enter-delay': enterDelay(index) }"
                    @contextmenu="openMenu($event, comment, comment.id)"
                  >
                    <div class="comment-head">
                      <div class="comment-avatar">
                        <BilibiliCoverImage v-if="comment.avatar_url" :src="comment.avatar_url" loading="lazy">
                          <span class="material-symbols-rounded filled">person</span>
                        </BilibiliCoverImage>
                        <span v-else class="material-symbols-rounded filled">person</span>
                      </div>
                      <div class="comment-who">
                        <span class="comment-user">{{ displayName(comment) }}</span>
                        <span v-if="comment.time_ms" class="comment-time">{{ formatTime(comment.time_ms) }}</span>
                      </div>
                      <span v-if="comment.user_level" class="comment-level">{{ t('player.comments_level', { level: comment.user_level }) }}</span>
                      <span class="comment-floor">{{ t('player.comments_floor', { floor: index + 1 }) }}</span>
                    </div>

                    <p class="comment-content"><template v-for="(segment, segmentIndex) in segments(comment)" :key="segmentIndex"><img
                      v-if="segment.kind === 'emote'"
                      class="comment-emote"
                      :src="segment.emote.url"
                      :alt="segment.emote.placeholder"
                      :title="segment.emote.placeholder"
                      referrerpolicy="no-referrer"
                      loading="lazy"
                    ><template v-else>{{ segment.text }}</template></template></p>

                    <div
                      v-if="comment.images.length"
                      class="comment-images"
                      :class="{ single: comment.images.length === 1 }"
                    >
                      <button
                        v-for="(image, imageIndex) in comment.images.slice(0, 9)"
                        :key="image.url"
                        class="comment-image"
                        :style="comment.images.length === 1 ? singleImageStyle(image) : undefined"
                        :aria-label="t('player.comments_image')"
                        @click="openPreview(comment.images, imageIndex)"
                      >
                        <BilibiliCoverImage :src="image.url" loading="lazy" />
                      </button>
                    </div>

                    <div v-if="comment.quotes.length" class="comment-quotes">
                      <div v-for="(quote, quoteIndex) in comment.quotes" :key="quoteIndex" class="comment-quote">
                        <span class="comment-quote-who">{{ t('player.comments_reply_to', { name: quote.user_name || t('player.comments_anonymous') }) }}</span>
                        <span class="comment-quote-text">{{ quote.content ?? t('player.comments_deleted') }}</span>
                      </div>
                    </div>

                    <div class="replies-collapse" :class="{ open: repliesOpen(comment) }">
                      <div class="replies-inner">
                        <TransitionGroup name="reply" tag="div" class="comment-replies">
                          <div
                            v-for="reply in visibleReplies(comment)"
                            :key="reply.id"
                            class="reply"
                            @contextmenu.stop="openMenu($event, reply, comment.id)"
                          >
                            <div class="reply-avatar">
                              <BilibiliCoverImage v-if="reply.avatar_url" :src="reply.avatar_url" loading="lazy">
                                <span class="material-symbols-rounded filled">person</span>
                              </BilibiliCoverImage>
                              <span v-else class="material-symbols-rounded filled">person</span>
                            </div>
                            <div class="reply-main">
                              <div class="reply-meta">
                                <span class="reply-user">{{ displayName(reply) }}</span>
                                <span v-if="reply.time_ms" class="comment-time">{{ formatTime(reply.time_ms) }}</span>
                              </div>
                              <p class="reply-content"><template v-for="(segment, segmentIndex) in segments(reply)" :key="segmentIndex"><img
                                v-if="segment.kind === 'emote'"
                                class="comment-emote"
                                :src="segment.emote.url"
                                :alt="segment.emote.placeholder"
                                :title="segment.emote.placeholder"
                                referrerpolicy="no-referrer"
                                loading="lazy"
                              ><template v-else>{{ segment.text }}</template></template></p>
                              <div v-if="reply.images.length" class="comment-images small">
                                <button
                                  v-for="(image, imageIndex) in reply.images.slice(0, 9)"
                                  :key="image.url"
                                  class="comment-image"
                                  :aria-label="t('player.comments_image')"
                                  @click="openPreview(reply.images, imageIndex)"
                                >
                                  <BilibiliCoverImage :src="image.url" loading="lazy" />
                                </button>
                              </div>
                              <div v-if="reply.quotes.length" class="comment-quotes">
                                <div v-for="(quote, quoteIndex) in reply.quotes" :key="quoteIndex" class="comment-quote">
                                  <span class="comment-quote-who">{{ t('player.comments_reply_to', { name: quote.user_name || t('player.comments_anonymous') }) }}</span>
                                  <span class="comment-quote-text">{{ quote.content ?? t('player.comments_deleted') }}</span>
                                </div>
                              </div>
                              <div class="reply-actions">
                                <button class="comment-text-btn" :disabled="!loggedIn || sending" @click="startReply(reply, comment.id)">
                                  {{ t('player.comments_reply') }}
                                </button>
                                <button
                                  class="comment-like small"
                                  :class="{ liked: reply.liked }"
                                  :disabled="!likeEnabled || likingIds.has(reply.id)"
                                  :aria-pressed="reply.liked"
                                  :aria-label="t(reply.liked ? 'player.comments_unlike' : 'player.comments_like')"
                                  @click="toggleLike(reply)"
                                >
                                  <span v-if="likingIds.has(reply.id)" class="material-symbols-rounded spinning">progress_activity</span>
                                  <Transition v-else name="like-pop" mode="out-in">
                                    <span :key="String(reply.liked)" class="material-symbols-rounded" :class="{ filled: reply.liked }">thumb_up</span>
                                  </Transition>
                                  <span class="comment-like-count">{{ formatCount(reply.like_count) }}</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </TransitionGroup>
                        <div v-if="threads[comment.id]" class="replies-footer">
                          <span v-if="threads[comment.id].loading" class="material-symbols-rounded spinning small">progress_activity</span>
                          <button v-else-if="threads[comment.id].failed" class="comment-text-btn" @click="retryReplies(comment.id)">
                            {{ t('player.comments_replies_failed') }} · {{ t('player.retry') }}
                          </button>
                          <button v-else-if="threads[comment.id].hasMore" class="comment-text-btn" @click="loadReplies(comment.id)">
                            {{ t('player.comments_more_replies') }}
                          </button>
                          <span v-else-if="!threads[comment.id].items.length" class="replies-empty">{{ t('player.comments_empty_replies') }}</span>
                        </div>
                      </div>
                    </div>

                    <div class="comment-actions">
                      <button class="comment-chip-btn" :disabled="!loggedIn || sending" @click="startReply(comment, comment.id)">
                        <span class="material-symbols-rounded">reply</span>{{ t('player.comments_reply') }}
                      </button>
                      <button
                        v-if="threads[comment.id] || hasHiddenReplies(comment)"
                        class="comment-chip-btn"
                        :disabled="threads[comment.id]?.loading && !threads[comment.id]?.items.length"
                        @click="toggleReplies(comment)"
                      >
                        <span class="material-symbols-rounded chevron" :class="{ flipped: threads[comment.id]?.expanded }">expand_more</span>
                        {{ threads[comment.id]?.expanded ? t('player.comments_hide_replies') : replyCountLabel(comment) }}
                      </button>
                      <button
                        class="comment-like"
                        :class="{ liked: comment.liked }"
                        :disabled="!likeEnabled || likingIds.has(comment.id)"
                        :aria-pressed="comment.liked"
                        :aria-label="t(comment.liked ? 'player.comments_unlike' : 'player.comments_like')"
                        @click="toggleLike(comment)"
                      >
                        <span v-if="likingIds.has(comment.id)" class="material-symbols-rounded spinning">progress_activity</span>
                        <Transition v-else name="like-pop" mode="out-in">
                          <span :key="String(comment.liked)" class="material-symbols-rounded" :class="{ filled: comment.liked }">thumb_up</span>
                        </Transition>
                        <span class="comment-like-count">{{ formatCount(comment.like_count) }}</span>
                      </button>
                    </div>
                  </article>
                </TransitionGroup>
                <div v-if="hasMore" ref="sentinel" class="comments-more">
                  <span v-if="loadingMore" class="material-symbols-rounded spinning small">progress_activity</span>
                  <button v-else-if="loadMoreFailed" class="comments-pill-btn" @click="retryLoadMore">{{ t('player.retry') }}</button>
                </div>
                <p v-else class="comments-end">{{ t('player.comments_no_more') }}</p>
              </div>
            </Transition>
          </div>

          <footer v-if="target" class="comments-composer">
            <Transition name="composer-row">
              <div v-if="replyTarget" class="composer-reply">
                <span class="material-symbols-rounded">reply</span>
                <span class="composer-reply-who">{{ t('player.comments_reply_to', { name: replyTarget.userName }) }}</span>
                <button class="comments-icon-btn small" :disabled="sending" :aria-label="t('player.comments_cancel_reply')" @click="cancelReply">
                  <span class="material-symbols-rounded">close</span>
                </button>
              </div>
            </Transition>
            <div class="composer-row" :class="{ error: overLimit, disabled: !loggedIn }">
              <textarea
                ref="draftInput"
                v-model="draft"
                class="composer-input"
                rows="1"
                :disabled="sending || !loggedIn"
                :placeholder="loggedIn ? (replyTarget ? t('player.comments_reply_to', { name: replyTarget.userName }) : t('player.comments_write_hint')) : t('player.comments_login_hint')"
                @keydown="onDraftKeydown"
                @input="onDraftInput"
              />
              <span v-if="draftLength" class="composer-count" :class="{ error: overLimit }">{{ draftLength }}/{{ lengthLimit }}</span>
              <button
                class="composer-send"
                :disabled="!canSend"
                :aria-label="t('player.comments_send')"
                :title="t('player.comments_send')"
                @click="sendComment"
              >
                <span v-if="sending" class="material-symbols-rounded spinning">progress_activity</span>
                <span v-else class="material-symbols-rounded filled">send</span>
              </button>
            </div>
            <Transition name="comments-fade">
              <p
                v-if="sendStatusText"
                :key="sendStatusText"
                class="composer-status"
                :class="{ error: sendStatus?.kind !== 'success' }"
              >{{ sendStatusText }}</p>
            </Transition>
          </footer>

          <Transition name="comments-fade">
            <div v-if="preview" class="comments-lightbox" @click.self="preview = null">
              <button class="comments-icon-btn lightbox-close" :aria-label="t('common.close')" @click="preview = null">
                <span class="material-symbols-rounded">close</span>
              </button>
              <button v-if="preview.images.length > 1" class="comments-icon-btn lightbox-nav prev" @click="stepPreview(-1)">
                <span class="material-symbols-rounded">chevron_left</span>
              </button>
              <Transition name="comments-fade" mode="out-in">
                <BilibiliCoverImage :key="preview.images[preview.index].url" :src="preview.images[preview.index].url" class="lightbox-image" />
              </Transition>
              <button v-if="preview.images.length > 1" class="comments-icon-btn lightbox-nav next" @click="stepPreview(1)">
                <span class="material-symbols-rounded">chevron_right</span>
              </button>
              <span v-if="preview.images.length > 1" class="lightbox-index">{{ preview.index + 1 }} / {{ preview.images.length }}</span>
            </div>
          </Transition>
        </aside>
      </div>
    </Transition>
  </Teleport>
  <ContextMenu v-model:open="menu.open" :x="menu.x" :y="menu.y" :items="menuItems" @click="onMenuClick" />
</template>

<style scoped lang="scss" src="./CommentsPanel.scss"></style>
