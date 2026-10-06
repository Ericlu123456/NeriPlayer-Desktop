import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/modules/library/localArtists.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  transformers: {
    before: [context => file => ts.visitNode(file, function visit(node) {
      if (ts.isImportDeclaration(node)) return undefined
      return ts.visitEachChild(node, visit, context)
    })],
  },
}).outputText
const { splitArtistNames, groupLocalArtists, sortLocalArtists, filterLocalArtists } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

assert.deepEqual(splitArtistNames(' Artist / artist; Guest、GUEST & Artist '), ['Artist', 'Guest'])
for (const separator of ['feat.', 'feat', 'ft.', 'FT', 'vs.', 'vs']) {
  assert.deepEqual(splitArtistNames(`Artist ${separator} Guest`), ['Artist', 'Guest'])
}
assert.deepEqual(splitArtistNames('Feather / Daft Punk'), ['Feather', 'Daft Punk'])
assert.deepEqual(splitArtistNames('  '), [])

const tracks = [
  { id: '1', title: 'First', artist: 'Zulu / zulu feat. Guest', album: 'First Album', coverUrl: '', addedAt: 1 },
  { id: '2', title: 'Second', artist: 'Zulu', album: 'Second Album', coverUrl: 'cover-zulu', addedAt: 3 },
  { id: '3', title: 'Third', artist: 'Alpha / Beta', album: 'Shared Album', coverUrl: 'cover-alpha', addedAt: 2 },
  { id: '4', title: 'Unknown song', artist: '', album: '', coverUrl: '', addedAt: 4 },
]
const artists = groupLocalArtists(tracks, '未知歌手')
const zulu = artists.find(artist => artist.key === 'zulu')
assert.deepEqual(zulu.tracks.map(track => track.id), ['1', '2'], 'one song counts once for the same artist')
assert.equal(zulu.coverUrl, 'cover-zulu')
assert.equal(zulu.latestAddedAt, 3)
assert.deepEqual(artists.find(artist => artist.key === 'guest').tracks.map(track => track.id), ['1'])
assert.deepEqual(artists.find(artist => artist.key === '未知歌手').tracks.map(track => track.id), ['4'])

const originalOrder = artists.map(artist => artist.key)
const countSorted = sortLocalArtists(artists, 'song_count')
assert.equal(countSorted[0].key, 'zulu', 'artists with more songs appear first')
assert.deepEqual(countSorted.slice(1).map(artist => artist.key),
  sortLocalArtists(artists.filter(artist => artist.key !== 'zulu'), 'name').map(artist => artist.key),
  'same counts are ordered by name')
assert.deepEqual(artists.map(artist => artist.key), originalOrder, 'sorting leaves the source array intact')
assert.equal(sortLocalArtists(artists, 'recent')[0].key, '未知歌手')
assert.equal(sortLocalArtists(artists.filter(artist => artist.key !== '未知歌手'), 'name')[0].key, 'alpha')
assert.deepEqual(filterLocalArtists(countSorted, ' SHARED ALBUM ').map(artist => artist.key), ['alpha', 'beta'])
assert.deepEqual(filterLocalArtists(countSorted, 'first').map(artist => artist.key), ['zulu', 'guest'])
assert.deepEqual(filterLocalArtists(countSorted, '').map(artist => artist.key), countSorted.map(artist => artist.key))
console.log('local artist grouping and sorting tests passed')
