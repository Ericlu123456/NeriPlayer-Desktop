// 平台相关的快捷键适配
//
// macOS 用 Command，Windows / Linux 用 Ctrl；统一用 isMacPlatform 区分，
// 避免各处硬编码平台名。

export type DesktopPlatform = 'mac' | 'windows' | 'linux'

function rawPlatform(): string {
  // 模块加载时就会调用；Node 20 等非浏览器环境没有全局 navigator
  if (typeof navigator === 'undefined') return ''
  const data = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
  return (data?.platform || navigator.platform || navigator.userAgent || '').toLowerCase()
}

export function detectPlatform(): DesktopPlatform {
  const value = rawPlatform()
  if (/mac|iphone|ipad|darwin/.test(value)) return 'mac'
  if (/win/.test(value)) return 'windows'
  return 'linux'
}

export const isMacPlatform = detectPlatform() === 'mac'

/// 焦点是否落在可输入元素上，是则让位给输入
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  // range 原生依赖方向键调值，必须视为可输入目标，否则全局方向键快捷键会劫持所有
  // 滑条（设置页音量/淡入淡出/模糊等 12+ 个滑条无法键盘调节，UI-003）
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(type)
}
