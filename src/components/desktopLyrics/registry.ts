import type { InjectionKey } from 'vue'

export interface KaraokeHandle {
  update(timeMs: number): void
}

/** 舞台每帧驱动已登记的歌词行；返回值用于注销 */
export const KARAOKE_REGISTRY: InjectionKey<(handle: KaraokeHandle) => () => void> = Symbol('desktop-lyrics-karaoke')
