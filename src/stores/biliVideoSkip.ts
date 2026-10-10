import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  biliVideoSkipTargetKey,
  normalizeBiliSkipIntervals,
  normalizeBiliVideoSkipRules,
  normalizeBiliVideoSkipTarget,
  type BiliVideoSkipInterval,
  type BiliVideoSkipRule,
  type BiliVideoSkipTarget,
} from '@/modules/playback/biliVideoSkip'
import { persistUserData, preloadedUserData } from '@/modules/persistence/userData'

const STORAGE_KEY = 'neri:bili-video-skip-rules'

function readRules(): BiliVideoSkipRule[] {
  const snapshot = preloadedUserData()
  if (snapshot) return normalizeBiliVideoSkipRules(snapshot.biliVideoSkipRules)
  try {
    return normalizeBiliVideoSkipRules(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'))
  } catch {
    return []
  }
}

export const useBiliVideoSkipStore = defineStore('biliVideoSkip', () => {
  const rules = ref<BiliVideoSkipRule[]>(readRules())

  function storedRuleFor(target: BiliVideoSkipTarget): BiliVideoSkipRule | null {
    const normalized = normalizeBiliVideoSkipTarget(target)
    if (!normalized) return null
    return rules.value.find(rule => biliVideoSkipTargetKey(rule) === biliVideoSkipTargetKey(normalized)) ?? null
  }

  function ruleFor(target: BiliVideoSkipTarget): BiliVideoSkipRule | null {
    const rule = storedRuleFor(target)
    return rule && !rule.isDeleted ? rule : null
  }

  async function setIntervals(
    target: BiliVideoSkipTarget,
    intervals: readonly BiliVideoSkipInterval[],
    durationMs = 0,
  ): Promise<BiliVideoSkipRule | null> {
    const normalizedTarget = normalizeBiliVideoSkipTarget(target)
    if (!normalizedTarget) throw new Error('Bilibili skip intervals require a BVID and CID')
    const normalizedIntervals = normalizeBiliSkipIntervals(intervals, durationMs)
    const previous = storedRuleFor(normalizedTarget)
    const isDeleted = !normalizedIntervals.length
    if (!previous && isDeleted) return null
    if (previous?.isDeleted === isDeleted && JSON.stringify(previous.intervals) === JSON.stringify(normalizedIntervals)) return previous

    const updated = preloadedUserData()
      ? await persistUserData<BiliVideoSkipRule | null>('set_bili_video_skip_rule', {
          ...normalizedTarget,
          intervals: normalizedIntervals,
          durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
        })
      : { ...normalizedTarget, intervals: normalizedIntervals, modifiedAt: Math.max(Date.now(), (previous?.modifiedAt ?? 0) + 1), isDeleted }
    if (!updated) return null
    const next = normalizeBiliVideoSkipRules([...rules.value, updated])
    // 保存确认后再更新内存，失败时编辑器仍保留可重试的原值
    if (!preloadedUserData()) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    rules.value = next
    return updated
  }

  function replaceFromSync(incoming: readonly BiliVideoSkipRule[]) {
    // 同步响应可能晚于本机保存，以规则时间和删除标记防止旧快照覆盖新编辑
    const next = normalizeBiliVideoSkipRules([...rules.value, ...incoming])
    if (!preloadedUserData()) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    rules.value = next
  }

  return { rules, ruleFor, setIntervals, replaceFromSync }
})
