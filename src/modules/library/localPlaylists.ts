const LOCAL_FILES_NAMES = new Set(['本地音乐', '本機音樂', 'ローカル音楽', 'Local Music'])

export function isEmptyLocalFilesPlaylist(playlist: { id: number; name: string; track_count: number }): boolean {
  return playlist.track_count === 0 && (playlist.id === -1002 || LOCAL_FILES_NAMES.has(playlist.name))
}
