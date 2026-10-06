const LOCAL_FILES_NAMES = new Set(['本地音乐', '本機音樂', 'ローカル音楽', 'Local Music'])

/** 旧版只写在 localStorage 的歌单自定义顺序，迁移到数据库后删除 */
export const LEGACY_PLAYLIST_ORDER_KEY = 'neri:playlist-order'

export function isEmptyLocalFilesPlaylist(playlist: { id: number; name: string; track_count: number }): boolean {
  return playlist.track_count === 0 && (playlist.id === -1002 || LOCAL_FILES_NAMES.has(playlist.name))
}

/** 提交给后端的自定义顺序：系统歌单固定首尾，不参与排序 */
export function playlistOrderIds<T extends { id: number | string }>(
  playlists: readonly T[],
  isProtected: (playlist: T) => boolean,
): string[] {
  return playlists.filter(playlist => !isProtected(playlist)).map(playlist => String(playlist.id))
}

/**
 * 读取旧版本地顺序；没有旧数据返回 null，损坏的旧数据返回空数组
 * （调用方随后会删除这个键，不会每次启动重复尝试）
 */
export function readLegacyPlaylistOrder(storage: Pick<Storage, 'getItem'> | undefined): string[] | null {
  const raw = storage?.getItem(LEGACY_PLAYLIST_ORDER_KEY)
  if (raw === null || raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(value => String(value)).filter(id => /^-?\d+$/.test(id))
  } catch {
    return []
  }
}
