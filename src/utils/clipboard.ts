import { isTauri } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

// 原生剪贴板不受 WebView 的 Clipboard API 权限或实现限制
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) await writeText(text)
  else await navigator.clipboard.writeText(text)
}
