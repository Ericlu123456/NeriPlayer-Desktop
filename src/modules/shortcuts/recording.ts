import { ref } from 'vue'

/// 设置页正在录制组合键：应用内快捷键让位，系统级快捷键临时全部注销，按下的键只用来改绑
export const shortcutRecording = ref(false)
