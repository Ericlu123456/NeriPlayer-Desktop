// 设置页折叠过渡 hooks：高度从 0 到 scrollHeight，再交还给内容自动高度。
// Expand/collapse transition hooks for the settings page: animate height from 0 to
// scrollHeight, then hand the auto height back to the content.
//
// 抽成 composable 是因为设置页拆成多个 section 组件后，折叠动画要被父子组件共用，
// 但状态（哪个 section 展开）仍留在 SettingsView。
// It is a composable because the settings page is split into section components that
// share the animation while the expanded state stays in SettingsView.
export function useExpandTransition() {
  function onExpandEnter(el: Element) {
    const element = el as HTMLElement
    element.style.overflow = 'hidden'
    element.style.height = '0'
    // 强制 reflow，否则浏览器会把起止高度合并成一次布局
    // Force a reflow so the browser does not coalesce the start and end heights.
    void element.offsetHeight
    element.style.transition = 'height 300ms cubic-bezier(0.2, 0, 0, 1), opacity 250ms ease'
    element.style.height = `${element.scrollHeight}px`
    element.style.opacity = '1'
  }

  function onExpandAfterEnter(el: Element) {
    const element = el as HTMLElement
    element.style.height = ''
    element.style.overflow = ''
    element.style.transition = ''
  }

  function onExpandLeave(el: Element) {
    const element = el as HTMLElement
    element.style.overflow = 'hidden'
    element.style.height = `${element.scrollHeight}px`
    void element.offsetHeight
    element.style.transition = 'height 250ms cubic-bezier(0.3, 0, 0.8, 0.15), opacity 200ms ease'
    element.style.height = '0'
    element.style.opacity = '0'
  }

  function onExpandAfterLeave(el: Element) {
    const element = el as HTMLElement
    element.style.height = ''
    element.style.overflow = ''
    element.style.transition = ''
    element.style.opacity = ''
  }

  return { onExpandEnter, onExpandAfterEnter, onExpandLeave, onExpandAfterLeave }
}
