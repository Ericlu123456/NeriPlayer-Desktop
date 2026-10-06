import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/modules/library/localPlaylists.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const { isEmptyLocalFilesPlaylist } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

assert.equal(isEmptyLocalFilesPlaylist({ id: -1002, name: '本地文件', track_count: 0 }), true)
assert.equal(isEmptyLocalFilesPlaylist({ id: 5, name: 'Local Music', track_count: 0 }), true)
assert.equal(isEmptyLocalFilesPlaylist({ id: -1002, name: '本地文件', track_count: 1 }), false)
assert.equal(isEmptyLocalFilesPlaylist({ id: 6, name: '自己的空歌单', track_count: 0 }), false)
console.log('local playlist visibility tests passed')
