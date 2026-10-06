import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import * as pinia from 'pinia'
import ts from 'typescript'

let sequence = 0
async function load(source, dependencies = {}) {
  const key = `__downloadTest${++sequence}`
  globalThis[key] = dependencies
  let compiled = ts.transpileModule(source.replaceAll('import.meta.hot', 'undefined'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const parsed = ts.createSourceFile('test.mjs', compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  for (const node of [...parsed.statements].reverse()) {
    if (!ts.isImportDeclaration(node)) continue
    const name = node.moduleSpecifier.text
    assert.ok(name in dependencies, `missing dependency ${name}`)
    const clause = node.importClause
    const assignments = []
    if (clause?.name) assignments.push(`const ${clause.name.text} = deps[${JSON.stringify(name)}].default`)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const names = clause.namedBindings.elements.map(item => item.propertyName ? `${item.propertyName.text}: ${item.name.text}` : item.name.text)
      assignments.push(`const { ${names.join(', ')} } = deps[${JSON.stringify(name)}]`)
    }
    compiled = compiled.slice(0, node.getStart(parsed)) + assignments.join(';\n') + compiled.slice(node.end)
  }
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(`const deps = globalThis[${JSON.stringify(key)}];\n${compiled}`).toString('base64')}`)
  } finally { delete globalThis[key] }
}
const root = new URL('../src/', import.meta.url)
const source = await readFile(new URL('stores/download.ts', root), 'utf8')
const queue = await load(await readFile(new URL('modules/download/downloadQueue.ts', root), 'utf8'))
const cancellation = await load(await readFile(new URL('modules/download/downloadCancellation.ts', root), 'utf8'))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await vue.nextTick() } }
const track = id => ({ id: `netease:${id}`, title: id, artist: 'Artist', album: 'Album', durationMs: 10000 })
const stream = { url: 'https://fixture.test/audio.mp3', durationMs: 10000 }

async function runtime(options = {}) {
  const events = new Map()
  const invoked = []
  const resolved = []
  const messages = []
  const settings = vue.reactive({
    downloadParallelism: 1, downloadFollowPlaybackQuality: false,
    downloadNeteaseQuality: 'exhigh', downloadQqMusicQuality: 'high',
    downloadBiliQuality: 'high', downloadYoutubeQuality: 'high',
    downloadDir: '', downloadNameTemplate: '',
  })
  const loaded = await load(source, {
    pinia, vue,
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      invoked.push({ command, args })
      if (command === 'validate_downloads') return { tracks: options.downloads || [] }
      if (command === 'delete_download' && options.deleteError) throw new Error('fixture delete failed')
      if (command === 'cancel_download') return options.cancel ? options.cancel.promise : false
      if (command === 'cancel_all_downloads') return 0
      if (command === 'download_track') events.get('download-progress')?.({ payload: { trackId: args.trackId, status: 'start' } })
    } },
    '@tauri-apps/api/event': { listen: async (name, callback) => {
      if (name === 'download-progress' && options.listening) await options.listening.promise
      events.set(name, callback)
      return () => events.delete(name)
    } },
    './settings': { useSettingsStore: () => settings },
    './toast': { useToastStore: () => Object.fromEntries(['show', 'error', 'success'].map(method => [method, (...args) => messages.push({ method, args })])) },
    '@/i18n': { default: { global: { t: key => key } } },
    '@/utils/logger': { createLogger: () => ({ error() {} }) },
    '@/modules/playback/playbackSource': { resolveDownloadSource: async (item, quality) => {
      resolved.push({ item, quality })
      return options.resolve ? options.resolve(item) : stream
    } },
    '@/modules/download/downloadCancellation': cancellation,
    '@/modules/download/downloadQueue': queue,
  })
  pinia.setActivePinia(pinia.createPinia())
  const store = loaded.useDownloadStore()
  return { store, settings, invoked, resolved, messages, emit: payload => events.get('download-progress')({ payload }) }
}

{
  const gate = deferred()
  const r = await runtime({ listening: gate })
  await r.store.downloadTrack(track('a'))
  await r.store.downloadTrack(track('b'))
  assert.equal(r.store.downloading.get('netease:b').status, 'queued')
  assert.equal(r.resolved.length, 0)
  await r.store.cancelDownload('netease:a')
  gate.resolve()
  await flush()
  assert.deepEqual(r.resolved.map(item => item.item.id), ['netease:b'])
  assert.equal(r.store.downloading.get('netease:a').status, 'cancelled')
  assert.equal(r.invoked.filter(item => item.command === 'download_track').length, 1)
}
{
  const r = await runtime()
  for (const id of ['a', 'b', 'c']) await r.store.downloadTrack(track(id))
  await flush()
  assert.equal(r.resolved.length, 1)
  assert.equal(r.resolved[0].quality.neteaseQuality, 'exhigh')
  r.emit({ trackId: 'netease:a', status: 'processing' })
  assert.equal(r.store.downloading.get('netease:a').status, 'processing')
  r.settings.downloadParallelism = 2
  await flush()
  assert.equal(r.resolved.length, 2)
  r.settings.downloadParallelism = 1
  await flush()
  r.emit({ trackId: 'netease:a', status: 'complete' })
  await flush()
  assert.equal(r.resolved.length, 2)
  r.emit({ trackId: 'netease:b', status: 'complete' })
  await flush()
  assert.equal(r.resolved.length, 3)
  r.emit({ trackId: 'netease:c', status: 'error', message: 'fixture failure' })
  assert.equal(r.store.isDownloading('netease:c'), false)
  assert.equal(r.store.downloading.get('netease:c').message, 'fixture failure')
  r.store.retryDownload('netease:c')
  await flush()
  assert.equal(r.resolved.length, 4)
  assert.equal(r.store.isDownloading('netease:c'), true)
  r.emit({ trackId: 'netease:c', status: 'cancelled' })
  r.store.clearFinishedTasks()
  assert.equal(r.store.downloading.size, 0)
}
{
  const resolution = deferred()
  const r = await runtime({ resolve: () => resolution.promise })
  await r.store.downloadTrack(track('a'))
  await r.store.downloadTrack(track('b'))
  await flush()
  await r.store.cancelAllDownloads()
  resolution.reject(new Error('fixture resolver failed after cancellation'))
  await flush()
  assert.equal(r.invoked.filter(item => item.command === 'download_track').length, 0)
  assert.equal(r.resolved.length, 1)
  assert.equal(r.store.downloading.get('netease:a').status, 'cancelled')
  assert.equal(r.store.downloading.get('netease:b').status, 'cancelled')
  assert.equal(r.messages.filter(item => item.method === 'error').length, 0)
}
{
  const resolution = deferred(), cancel = deferred()
  const r = await runtime({ resolve: () => resolution.promise, cancel })
  await r.store.downloadTrack(track('a'))
  await flush()
  const cancelling = r.store.cancelDownload('netease:a')
  resolution.resolve(stream)
  await flush()
  cancel.resolve(false)
  assert.equal(await cancelling, true)
  assert.equal(r.invoked.filter(item => item.command === 'download_track').length, 0)
  assert.equal(r.store.downloading.get('netease:a').status, 'cancelled')
}
for (const failed of [false, true]) {
  const resolution = deferred()
  const r = await runtime({ resolve: () => resolution.promise })
  await r.store.downloadTrack(track('a'))
  await flush()
  await r.store.cancelDownload('netease:a')
  r.store.clearFinishedTasks()
  assert.equal(r.store.downloading.size, 0)
  if (failed) resolution.reject(new Error('fixture failure'))
  else resolution.resolve(stream)
  await flush()
  assert.equal(r.store.downloading.size, 0)
}
for (const retained of [false, true]) {
  const saved = { id: 'netease:a', title: 'A', artist: 'Artist', album: 'Album', duration_ms: 10000, source: 'netease', file_path: 'E:/Music/a.mp3', file_size: 1024, downloaded_at: 1 }
  const r = await runtime({ deleteError: true, downloads: retained ? [saved] : [] })
  r.store.downloads = [{ id: saved.id, title: saved.title, artist: saved.artist, album: saved.album, durationMs: saved.duration_ms, source: saved.source, filePath: saved.file_path, fileSize: saved.file_size, downloadedAt: saved.downloaded_at }]
  await assert.rejects(r.store.deleteDownload(saved.id), /fixture delete failed/)
  assert.equal(r.store.downloads.length, retained ? 1 : 0, 'failed deletion refreshes the actual manifest state')
}
console.log('download store lifecycle tests passed')
