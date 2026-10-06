import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/modules/library/localPlaylists.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const {
  LEGACY_PLAYLIST_ORDER_KEY,
  isEmptyLocalFilesPlaylist,
  playlistOrderIds,
  readLegacyPlaylistOrder,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

assert.equal(isEmptyLocalFilesPlaylist({ id: -1002, name: '本地文件', track_count: 0 }), true)
assert.equal(isEmptyLocalFilesPlaylist({ id: 5, name: 'Local Music', track_count: 0 }), true)
assert.equal(isEmptyLocalFilesPlaylist({ id: -1002, name: '本地文件', track_count: 1 }), false)
assert.equal(isEmptyLocalFilesPlaylist({ id: 6, name: '自己的空歌单', track_count: 0 }), false)

const playlists = [
  { id: -1001, name: '我喜欢的音乐' },
  { id: 9007199254740991, name: 'Large' },
  { id: 3, name: 'Small' },
  { id: -1002, name: '本地音乐' },
]
const isProtected = (playlist) => playlist.id < 0
assert.deepEqual(playlistOrderIds(playlists, isProtected), ['9007199254740991', '3'])

const storage = (value) => ({ getItem: (key) => (key === LEGACY_PLAYLIST_ORDER_KEY ? value : null) })
assert.equal(readLegacyPlaylistOrder(undefined), null)
assert.equal(readLegacyPlaylistOrder(storage(null)), null)
assert.deepEqual(readLegacyPlaylistOrder(storage('[3, "7", 1.5, "x", -4]')), ['3', '7', '-4'])
assert.deepEqual(readLegacyPlaylistOrder(storage('{broken')), [])
assert.deepEqual(readLegacyPlaylistOrder(storage('{"a":1}')), [])
console.log('local playlist visibility and order tests passed')
