<script setup lang="ts">
// 桌面歌词的排版：单行 + 第二行、双行交替（KTV）、三行滚动；歌词窗口和设置页预览共用
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import KaraokeLine from './KaraokeLine.vue'
import { KARAOKE_REGISTRY, type KaraokeHandle } from './registry'
import type { DesktopLyricsFrameLine } from '@/modules/desktopLyrics/frame'
import { desktopLyricsCssVars, type DesktopLyricsStyle } from '@/modules/desktopLyrics/style'
import { activeLineIndex, lineEndMs } from '@/modules/desktopLyrics/timeline'

const props = defineProps<{
  lines: DesktopLyricsFrameLine[]
  /** lines[0] 在整首歌词里的下标；双行布局按奇偶决定上下槽位 */
  firstIndex: number
  /** 当前歌词时间（已加偏移），每帧调用 */
  clock: () => number
  style: DesktopLyricsStyle
  accent: string | null
  /** 没有歌词或还没到第一句时显示 */
  placeholder: string
}>()

const active = ref(-1)
// 每行挂载时自己登记、卸载时只移走自己：换行过渡期间新旧两行同时存在
const handles = new Set<KaraokeHandle>()
provide(KARAOKE_REGISTRY, (handle: KaraokeHandle) => {
  handles.add(handle)
  return () => { handles.delete(handle) }
})
let frame = 0

const cssVars = computed(() => desktopLyricsCssVars(props.style, props.accent))
const lineEnds = computed(() => props.lines.map((_, index) => lineEndMs(props.lines, index)))

const current = computed(() => props.lines[active.value] ?? null)
const nextLine = computed(() => props.lines[active.value + 1] ?? null)
const previous = computed(() => props.lines[active.value - 1] ?? null)

const secondaryText = computed(() => {
  const line = current.value
  switch (props.style.secondary) {
    case 'translation': return line?.translation || ''
    case 'romanization': return line?.roman || ''
    case 'next': return (active.value < 0 ? props.lines[0]?.text : nextLine.value?.text) || ''
    default: return ''
  }
})

/** 双行：当前句在奇偶对应的槽位，另一槽放下一句 */
const doubleSlots = computed(() => {
  if (active.value < 0) {
    return { top: props.lines[0] ?? null, bottom: props.lines[1] ?? null, topActive: false, bottomActive: false }
  }
  const evenLine = (props.firstIndex + active.value) % 2 === 0
  return evenLine
    ? { top: current.value, bottom: nextLine.value, topActive: true, bottomActive: false }
    : { top: nextLine.value, bottom: current.value, topActive: false, bottomActive: true }
})

const lineKey = computed(() => `${props.firstIndex + active.value}`)

function tick() {
  frame = requestAnimationFrame(tick)
  const time = props.clock()
  const index = activeLineIndex(props.lines, time)
  if (index !== active.value) active.value = index
  for (const handle of handles) handle.update(time)
}

watch(() => props.lines, () => { active.value = activeLineIndex(props.lines, props.clock()) })

onMounted(() => { frame = requestAnimationFrame(tick) })
onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <div class="dl-stage" :class="[`layout-${style.layout}`, `align-${style.align}`]" :style="cssVars">
    <template v-if="style.layout === 'double'">
      <KaraokeLine
        class="dl-double-top"
        :line="doubleSlots.top"
        :fallback="placeholder"
        :end-ms="doubleSlots.top ? lineEnds[lines.indexOf(doubleSlots.top)] : 0"
        :karaoke="style.karaoke"
        :align="style.align === 'center' ? 'center' : 'left'"
        :upcoming="!doubleSlots.topActive"
      />
      <KaraokeLine
        class="dl-double-bottom"
        :line="doubleSlots.bottom"
        :fallback="'\u00a0'"
        :end-ms="doubleSlots.bottom ? lineEnds[lines.indexOf(doubleSlots.bottom)] : 0"
        :karaoke="style.karaoke"
        :align="style.align === 'center' ? 'center' : 'right'"
        :upcoming="!doubleSlots.bottomActive"
      />
    </template>

    <template v-else>
      <p v-if="style.layout === 'triple'" class="dl-adjacent">{{ previous?.text || '\u00a0' }}</p>
      <Transition name="dl-swap">
        <KaraokeLine
          :key="lineKey"
          class="dl-current"
          :line="current"
          :fallback="placeholder"
          :end-ms="lineEnds[active] ?? 0"
          :karaoke="style.karaoke"
          :align="style.align"
        />
      </Transition>
      <p v-if="secondaryText" class="dl-secondary">{{ secondaryText }}</p>
      <p v-if="style.layout === 'triple'" class="dl-adjacent">{{ (style.secondary === 'next' ? lines[active + 2]?.text : nextLine?.text) || '\u00a0' }}</p>
    </template>
  </div>
</template>

<style scoped>
.dl-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.15em;
  width: 100%;
  min-width: 0;
  height: 100%;
  opacity: var(--dl-opacity);
  font-family: var(--dl-font-family);
  user-select: none;
}

.dl-current { position: relative; }

.dl-secondary,
.dl-adjacent {
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--dl-font-family);
  font-size: var(--dl-secondary-size);
  font-weight: 600;
  line-height: 1.35;
  color: var(--dl-secondary-color);
  filter: var(--dl-shadow);
  padding: 0 0.4em;
}

.dl-adjacent { opacity: 0.55; }

.align-left .dl-secondary, .align-left .dl-adjacent { text-align: left; }
.align-center .dl-secondary, .align-center .dl-adjacent { text-align: center; }
.align-right .dl-secondary, .align-right .dl-adjacent { text-align: right; }

.layout-double { gap: 0.05em; }
.dl-double-bottom { margin-top: -0.1em; }

.dl-swap-enter-active { transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.2, 0, 0, 1); }
.dl-swap-leave-active { position: absolute; left: 0; right: 0; transition: opacity 0.12s ease; }
.dl-swap-enter-from { opacity: 0; transform: translateY(0.25em); }
.dl-swap-leave-to { opacity: 0; }
</style>
