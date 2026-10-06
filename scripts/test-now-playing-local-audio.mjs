import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/modules/playback/audioQualityDisplay.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const { isLocalAudioPlayback, canSwitchAudioQuality, resolveAudioQualityLabel, actualAudioBitrateLabel } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

let fallbackCalls = 0
const fallback = (source, key) => { fallbackCalls++; return `${source}:${key || 'configured'}` }
const downloaded = { source: 'netease', fromDownload: true, info: { source: 'netease', qualityLabel: '极高', qualityKey: 'exhigh', bitrate: 317.8 } }
assert.equal(isLocalAudioPlayback(downloaded), true)
assert.equal(canSwitchAudioQuality(downloaded), false)
assert.equal(resolveAudioQualityLabel(downloaded, fallback), '')
assert.equal(fallbackCalls, 0)
assert.equal(actualAudioBitrateLabel(downloaded.info), '318 kbps')

for (const local of [
  { source: 'netease', fromDownload: true, info: null },
  { source: 'local', fromDownload: false, info: null },
  { source: 'netease', fromDownload: false, info: { source: 'local', qualityLabel: '无损' } },
  { source: 'youtube', fromDownload: true, info: { format: 'Opus' } },
]) {
  assert.equal(isLocalAudioPlayback(local), true)
  assert.equal(canSwitchAudioQuality(local), false)
  assert.equal(resolveAudioQualityLabel(local, fallback), '')
  assert.equal(actualAudioBitrateLabel(local.info), '')
}
assert.equal(fallbackCalls, 0, 'missing local bitrate must not use configured online quality')

for (const source of ['netease', 'qq', 'bilibili', 'youtube']) {
  const online = { source, fromDownload: false, info: null }
  assert.equal(canSwitchAudioQuality(online), true)
  assert.equal(resolveAudioQualityLabel(online, fallback), `${source}:configured`)
}
assert.equal(canSwitchAudioQuality({ source: 'unknown', fromDownload: false, info: null }), false)
assert.equal(resolveAudioQualityLabel({ source: 'youtube', fromDownload: false, info: { qualityLabel: '高', qualityKey: 'high' } }, fallback), '高')
assert.equal(resolveAudioQualityLabel({ source: 'netease', fromDownload: false, info: { qualityLabel: '320 kbps', qualityKey: 'exhigh' } }, fallback), 'netease:exhigh')
assert.equal(resolveAudioQualityLabel({ source: 'netease', fromDownload: false, info: { source: 'bilibili', qualityKey: 'high' } }, fallback), 'bilibili:high')
for (const bitrate of [undefined, NaN, Infinity, -1, 0]) assert.equal(actualAudioBitrateLabel({ bitrate }), '')

const componentSource = await readFile(new URL('../src/components/NowPlaying.vue', import.meta.url), 'utf8')
const script = componentSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const parsed = ts.createSourceFile('NowPlaying.ts', script, ts.ScriptTarget.ES2022, true)
const specFunction = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'paperSpecFromAudioInfo')
assert.ok(specFunction, 'playback page should retain its factual audio specification formatter')
const specCompiled = ts.transpileModule(`export ${specFunction.getText(parsed)}`, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const { paperSpecFromAudioInfo } = await import(`data:text/javascript;base64,${Buffer.from(specCompiled).toString('base64')}`)
assert.deepEqual(paperSpecFromAudioInfo({ sampleRateHz: 48000, bitDepth: 16, channelCount: 2, specLabel: '极高 | 320 kbps' }, false), ['48 kHz', '16 bit', '2 ch'])
assert.deepEqual(paperSpecFromAudioInfo({ specLabel: '48 kHz | 16 bit | 无损' }, false), [], 'local files must not inherit paper specifications from an online quality label')
assert.deepEqual(paperSpecFromAudioInfo({ sampleRateHz: 44100, bitDepth: 24 }, true), ['44.1 kHz', '24 bit'])
const displayFunctions = ['normalizeAudioDisplayToken', 'isHiddenAudioInfoToken'].map(name => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration)
  return `export ${declaration.getText(parsed)}`
}).join('\n')
const displayCompiled = ts.transpileModule(displayFunctions, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const { normalizeAudioDisplayToken } = await import(`data:text/javascript;base64,${Buffer.from(displayCompiled).toString('base64')}`)
assert.equal(normalizeAudioDisplayToken('mpeg', true), 'MPEG', 'a detected MPEG file may use layer 1, 2 or 3')
assert.equal(normalizeAudioDisplayToken('mpeg'), 'MP3', 'online display keeps its existing format mapping')
assert.equal(normalizeAudioDisplayToken('flac', true), 'FLAC')
console.log('now playing local audio quality tests passed')
