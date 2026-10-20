// 主窗口是否被收进托盘/隐藏。
// Whether the main window is hidden in the tray.
//
// WebKitGTK 不会可靠地把 GTK 窗口隐藏映射成 Page Visibility，rAF 和 CSS 动画会继续
// 跑；后端在 hide/show 时发事件，这里切换根类，供动画循环同步查询。
// WebKitGTK does not reliably map a hidden GTK window to Page Visibility, so rAF and
// CSS animations keep running. The backend emits an event on hide/show; this module
// toggles a root class that animation loops can read synchronously.
export function setRuntimeHidden(hidden: boolean): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  document.documentElement.classList.toggle('window-hidden', hidden)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('neri-runtime-visibility'))
  }
}
