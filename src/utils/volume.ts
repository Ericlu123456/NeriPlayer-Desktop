/** 音量按钮上滚轮一格调 5% */
export const VOLUME_WHEEL_STEP = 0.05

/** 向上滚加大、向下滚减小；结果落在 0~1，按百分比取整避免累积出 0.30000000000000004 */
export function wheelAdjustedVolume(current: number, deltaY: number): number {
  if (!deltaY) return current
  const next = current + (deltaY < 0 ? VOLUME_WHEEL_STEP : -VOLUME_WHEEL_STEP)
  return Math.round(Math.max(0, Math.min(1, next)) * 100) / 100
}
