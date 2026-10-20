// 睡眠定时器 / Sleep timer.
//
// 三种模式：倒计时暂停、本曲结束暂停、队列结束暂停。倒计时和曲尾判断在播放器 store
// 里触发，因此这里只暴露状态与命令，暂停动作由调用方注入。
// Three modes: countdown, end-of-track, end-of-queue. The player store owns the
// playback-side triggers, so this composable only exposes state and commands and
// receives the pause action as a callback.
import { computed, ref } from 'vue'

export type SleepTimerMode = 'countdown' | 'end_of_track' | 'end_of_queue' | null

export function useSleepTimer(onCountdownEnd: () => void) {
  const sleepTimerEndMs = ref(0) // 0 = 未启用 / 0 means disabled
  const sleepTimerMode = ref<SleepTimerMode>(null)
  const sleepTimerNowMs = ref(Date.now())
  let interval: ReturnType<typeof setInterval> | null = null

  /** 剩余睡眠时间（秒）；-1 表示等待本曲结束 / Seconds left; -1 waits for track end */
  const sleepRemainingSeconds = computed(() => {
    if (!sleepTimerMode.value || sleepTimerEndMs.value <= 0) return 0
    if (sleepTimerMode.value === 'end_of_track') return -1
    return Math.max(0, Math.ceil((sleepTimerEndMs.value - sleepTimerNowMs.value) / 1000))
  })

  function cancelSleepTimer() {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    sleepTimerMode.value = null
    sleepTimerEndMs.value = 0
    sleepTimerNowMs.value = Date.now()
  }

  function startSleepTimer(minutes: number) {
    cancelSleepTimer()
    const now = Date.now()
    sleepTimerMode.value = 'countdown'
    sleepTimerNowMs.value = now
    sleepTimerEndMs.value = now + minutes * 60 * 1000
    interval = setInterval(() => {
      const current = Date.now()
      sleepTimerNowMs.value = current
      if (current >= sleepTimerEndMs.value) {
        onCountdownEnd()
        cancelSleepTimer()
      }
    }, 1000)
  }

  function startSleepTimerEndOfTrack() {
    cancelSleepTimer()
    sleepTimerMode.value = 'end_of_track'
    sleepTimerEndMs.value = 1 // 非零表示启用 / non-zero means enabled
  }

  function startSleepTimerEndOfQueue() {
    cancelSleepTimer()
    sleepTimerMode.value = 'end_of_queue'
    sleepTimerEndMs.value = 1
  }

  return {
    sleepTimerMode,
    sleepRemainingSeconds,
    startSleepTimer,
    startSleepTimerEndOfTrack,
    startSleepTimerEndOfQueue,
    cancelSleepTimer,
  }
}
