<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import type { TrackInfo } from '@/stores/player'
import { resolveCommentTarget } from '@/modules/playback/commentTarget'
import { useEscapeClose } from '@/composables/useEscapeClose'
import BilibiliCoverImage from '@/components/BilibiliCoverImage.vue'

/// 评论（对齐 Android CommentSheet）：网易云歌曲评论与 B 站视频评论，YouTube / 本地没有评论入口
const props = defineProps<{ open: boolean; track: TrackInfo | null }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const { t, locale } = useI18n()

interface CommentItem {
  id: string
  user_name: string
  avatar_url: string | null
  content: string
  time_ms: number
  like_count: number
  reply_count: number
  reply_to: string | null
  preview_replies: CommentItem[]
  images: string[]
}

interface CommentPage {
  items: CommentItem[]
  total: number
  has_more: boolean
  cursor: string | null
}

type CommentSort = 'hot' | 'newest' | 'recommended'

interface ReplyThread {
  items: CommentItem[]
  cursor: string | null
  hasMore: boolean
  loading: boolean
  expanded: boolean
}

const target = computed(() => resolveCommentTarget(props.track))
const sorts = computed<CommentSort[]>(() => target.value?.platform === 'netease' ? ['hot', 'newest', 'recommended'] : ['hot', 'newest'])
const sort = ref<CommentSort>('hot')
const items = ref<CommentItem[]>([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const failed = ref(false)
const threads = ref<Record<string, ReplyThread>>({})
let page = 1
let cursor: string | null = null
let requestSeq = 0
let loadedKey = ''

useEscapeClose(() => props.open, () => emit('update:open', false))

function contextKey(): string {
  return target.value ? `${target.value.platform}:${target.value.target}:${sort.value}` : ''
}

async function reload() {
  const current = target.value
  const key = contextKey()
  loadedKey = key
  const requestId = ++requestSeq
  items.value = []
  threads.value = {}
  total.value = 0
  hasMore.value = false
  failed.value = false
  page = 1
  cursor = null
  if (!current) return
  loading.value = true
  try {
    const result = await invoke<CommentPage>('get_comments', { ...current, sort: sort.value, page: 1, cursor: null })
    if (requestId !== requestSeq) return
    items.value = result.items
    total.value = result.total
    hasMore.value = result.has_more
    cursor = result.cursor
  } catch {
    if (requestId === requestSeq) failed.value = true
  } finally {
    if (requestId === requestSeq) loading.value = false
  }
}

async function loadMore() {
  const current = target.value
  if (!current || !hasMore.value || loading.value || loadingMore.value) return
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
    if (requestId === requestSeq) hasMore.value = false
  } finally {
    if (requestId === requestSeq) loadingMore.value = false
  }
}

async function toggleReplies(comment: CommentItem) {
  const current = target.value
  if (!current) return
  const existing = threads.value[comment.id]
  if (existing?.expanded && !existing.hasMore) {
    threads.value = { ...threads.value, [comment.id]: { ...existing, expanded: false } }
    return
  }
  const thread: ReplyThread = existing
    ? { ...existing, expanded: true }
    : { items: [], cursor: null, hasMore: true, loading: false, expanded: true }
  threads.value = { ...threads.value, [comment.id]: thread }
  if (thread.loading || !thread.hasMore) return
  const requestId = requestSeq
  threads.value[comment.id] = { ...thread, loading: true }
  try {
    const result = await invoke<CommentPage>('get_comment_replies', { ...current, commentId: comment.id, cursor: thread.cursor })
    if (requestId !== requestSeq) return
    const previous = threads.value[comment.id]
    const seen = new Set(previous.items.map(item => item.id))
    threads.value = {
      ...threads.value,
      [comment.id]: {
        items: [...previous.items, ...result.items.filter(item => !seen.has(item.id))],
        cursor: result.cursor,
        hasMore: result.has_more && !!result.cursor,
        loading: false,
        expanded: true,
      },
    }
  } catch {
    if (requestId === requestSeq) threads.value = { ...threads.value, [comment.id]: { ...threads.value[comment.id], loading: false, hasMore: false } }
  }
}

function collapseReplies(comment: CommentItem) {
  const thread = threads.value[comment.id]
  if (thread) threads.value = { ...threads.value, [comment.id]: { ...thread, expanded: false } }
}

function visibleReplies(comment: CommentItem): CommentItem[] {
  const thread = threads.value[comment.id]
  return thread?.expanded && thread.items.length ? thread.items : comment.preview_replies
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

// 打开时才拉取；同一首、同一排序重新打开直接复用
watch(() => [props.open, contextKey()] as const, ([open, key]) => {
  if (open && key !== loadedKey) void reload()
}, { immediate: true })
watch(target, () => {
  if (!sorts.value.includes(sort.value)) sort.value = 'hot'
})

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
watch(sentinel, (element) => {
  observer?.disconnect()
  if (!element) return
  observer = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) void loadMore()
  }, { rootMargin: '300px 0px' })
  observer.observe(element)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <Teleport to="body">
    <Transition name="comments-sheet">
      <div v-if="open" class="comments-overlay" @click.self="emit('update:open', false)">
        <aside class="comments-panel" role="dialog" :aria-label="t('player.comments')">
          <header class="comments-header">
            <div class="comments-heading">
              <h3>{{ t('player.comments') }}</h3>
              <span v-if="total" class="comments-total">{{ t('player.comments_total', { count: total }) }}</span>
            </div>
            <button class="comments-close" :aria-label="t('common.close')" @click="emit('update:open', false)">
              <span class="material-symbols-rounded">close</span>
            </button>
          </header>
          <p v-if="track" class="comments-track">{{ track.title }}<span v-if="track.artist"> · {{ track.artist }}</span></p>

          <div v-if="target" class="comments-sorts" role="tablist">
            <button
              v-for="option in sorts"
              :key="option"
              role="tab"
              :aria-selected="sort === option"
              class="comments-sort"
              :class="{ active: sort === option }"
              @click="sort = option"
            >{{ t(`player.comments_${option}`) }}</button>
          </div>

          <div class="comments-body">
            <div v-if="!target" class="comments-state">
              <span class="material-symbols-rounded">comments_disabled</span>
              <p>{{ t('player.comments_unavailable') }}</p>
            </div>
            <div v-else-if="loading" class="comments-state">
              <span class="material-symbols-rounded spinning">progress_activity</span>
            </div>
            <div v-else-if="failed" class="comments-state">
              <span class="material-symbols-rounded">wifi_off</span>
              <p>{{ t('player.comments_failed') }}</p>
              <button class="comments-retry" @click="reload">{{ t('player.retry') }}</button>
            </div>
            <div v-else-if="!items.length" class="comments-state">
              <span class="material-symbols-rounded">chat_bubble</span>
              <p>{{ t('player.comments_empty') }}</p>
            </div>
            <template v-else>
              <article v-for="comment in items" :key="comment.id" class="comment">
                <div class="comment-avatar">
                  <BilibiliCoverImage v-if="comment.avatar_url" :src="comment.avatar_url" loading="lazy">
                    <span class="material-symbols-rounded filled">person</span>
                  </BilibiliCoverImage>
                  <span v-else class="material-symbols-rounded filled">person</span>
                </div>
                <div class="comment-main">
                  <div class="comment-meta">
                    <span class="comment-user">{{ comment.user_name }}</span>
                    <span class="comment-time">{{ formatTime(comment.time_ms) }}</span>
                    <span class="comment-like">
                      <span class="material-symbols-rounded">thumb_up</span>{{ formatCount(comment.like_count) }}
                    </span>
                  </div>
                  <p class="comment-content">{{ comment.content }}</p>
                  <p v-if="comment.reply_to" class="comment-quote">{{ comment.reply_to }}</p>
                  <div v-if="comment.images.length" class="comment-images">
                    <BilibiliCoverImage v-for="image in comment.images.slice(0, 3)" :key="image" :src="image" loading="lazy" class="comment-image" />
                  </div>

                  <div v-if="visibleReplies(comment).length" class="comment-replies">
                    <div v-for="reply in visibleReplies(comment)" :key="reply.id" class="comment-reply">
                      <span class="comment-user">{{ reply.user_name }}</span>
                      <span class="comment-reply-text">{{ reply.content }}</span>
                    </div>
                  </div>
                  <div v-if="comment.reply_count > 0" class="comment-reply-actions">
                    <button
                      v-if="!threads[comment.id]?.expanded || threads[comment.id]?.hasMore"
                      class="comment-reply-toggle"
                      :disabled="threads[comment.id]?.loading"
                      @click="toggleReplies(comment)"
                    >
                      <span v-if="threads[comment.id]?.loading" class="material-symbols-rounded spinning small">progress_activity</span>
                      {{ threads[comment.id]?.expanded ? t('player.comments_more_replies') : t('player.comments_replies', { count: comment.reply_count }) }}
                    </button>
                    <button v-if="threads[comment.id]?.expanded" class="comment-reply-toggle" @click="collapseReplies(comment)">
                      {{ t('player.comments_hide_replies') }}
                    </button>
                  </div>
                </div>
              </article>
              <div v-if="hasMore" ref="sentinel" class="comments-more">
                <span v-if="loadingMore" class="material-symbols-rounded spinning small">progress_activity</span>
              </div>
            </template>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
.comments-overlay {
  position: fixed;
  inset: 0;
  z-index: 260;
  display: flex;
  justify-content: flex-end;
  background: rgb(0 0 0 / 0.4);
}

.comments-panel {
  width: 420px;
  max-width: 92vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: var(--titlebar-height, 36px);
  background: var(--bg-solid-container, var(--md-surface-container));
  color: var(--md-on-surface);
  box-shadow: -4px 0 24px rgb(0 0 0 / 0.3);
}

/* 开合都走 transition：半路关掉会从当前位置反向收回，不会闪现 */
.comments-sheet-enter-active,
.comments-sheet-leave-active {
  transition: background-color 280ms var(--ease-standard);
  .comments-panel { transition: transform 320ms var(--ease-emphasized-decel); }
}
.comments-sheet-leave-active .comments-panel { transition-timing-function: var(--ease-emphasized-accel); transition-duration: 220ms; }
.comments-sheet-enter-from,
.comments-sheet-leave-to {
  background-color: transparent;
  .comments-panel { transform: translateX(100%); }
}

.comments-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 4px 20px;
}

.comments-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  h3 { font-size: 18px; font-weight: 600; }
}

.comments-total { font-size: 12px; color: var(--md-on-surface-variant); }

.comments-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--md-on-surface-variant);
  &:hover { background: var(--md-surface-container-highest); }
}

.comments-track {
  padding: 0 20px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comments-sorts {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--md-outline-variant);
}

.comments-sort {
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--md-outline-variant);
  font-size: 13px;
  color: var(--md-on-surface-variant);
  transition: background var(--duration-short) var(--ease-standard), color var(--duration-short) var(--ease-standard);
  &:hover { background: var(--md-surface-container-high); }
  &.active {
    background: var(--md-secondary-container);
    color: var(--md-on-secondary-container);
    border-color: transparent;
  }
}

.comments-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 24px;
  overscroll-behavior: contain;
}

.comments-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 64px 16px;
  color: var(--md-on-surface-variant);
  text-align: center;
  > .material-symbols-rounded { font-size: 36px; opacity: 0.5; }
  p { font-size: 13px; }
}

.comments-retry {
  padding: 6px 18px;
  border: 1px solid var(--md-outline-variant);
  border-radius: var(--radius-full);
  color: var(--md-primary);
  font-size: 13px;
}

.comment {
  display: flex;
  gap: 12px;
  padding: 12px 8px;
  border-radius: var(--radius-md);
  & + & { border-top: 1px solid color-mix(in srgb, var(--md-outline-variant) 50%, transparent); }
}

.comment-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: var(--md-surface-container-high);
  color: var(--md-on-surface-variant);
  :deep(img) { width: 100%; height: 100%; object-fit: cover; }
  .material-symbols-rounded { font-size: 20px; }
}

.comment-main { flex: 1; min-width: 0; }

.comment-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--md-on-surface-variant);
}

.comment-user {
  font-weight: 600;
  color: var(--md-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment-time { flex-shrink: 0; }

.comment-like {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  .material-symbols-rounded { font-size: 14px; }
}

.comment-content {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.comment-quote {
  margin-top: 8px;
  padding: 6px 10px;
  border-left: 3px solid var(--md-outline-variant);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--md-surface-container-high);
  font-size: 12px;
  color: var(--md-on-surface-variant);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.comment-images {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.comment-image {
  width: 88px;
  height: 88px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  :deep(img) { width: 100%; height: 100%; object-fit: cover; }
}

.comment-replies {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--md-surface-container-high);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}

.comment-reply { overflow-wrap: anywhere; }
.comment-reply .comment-user { margin-right: 6px; }
.comment-reply-text { color: var(--md-on-surface-variant); white-space: pre-wrap; user-select: text; }

.comment-reply-actions { display: flex; gap: 12px; margin-top: 6px; }

.comment-reply-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--md-primary);
  &:disabled { opacity: 0.6; }
}

.comments-more {
  display: flex;
  justify-content: center;
  min-height: 40px;
  padding: 8px 0;
  color: var(--md-on-surface-variant);
}

.spinning { animation: comments-spin 1s linear infinite; }
.spinning.small { font-size: 18px; }
@keyframes comments-spin { to { transform: rotate(360deg); } }
</style>
