import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import * as pinia from 'pinia'
import ts from 'typescript'

const source = await readFile(new URL('../src/stores/library.ts', import.meta.url), 'utf8')
let sequence = 0
async function load(dependencies) {
  const key = `__localScanTest${++sequence}`
  globalThis[key] = dependencies
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  const parsed = ts.createSourceFile('test.mjs', compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  for (const node of [...parsed.statements].reverse()) {
    if (!ts.isImportDeclaration(node)) continue
    const name = node.moduleSpecifier.text
    assert.ok(name in dependencies, `missing dependency ${name}`)
    const names = node.importClause.namedBindings.elements.map(item => item.propertyName ? `${item.propertyName.text}: ${item.name.text}` : item.name.text)
    const assignment = `const { ${names.join(', ')} } = deps[${JSON.stringify(name)}]`
    compiled = compiled.slice(0, node.getStart(parsed)) + assignment + compiled.slice(node.end)
  }
  try { return await import(`data:text/javascript;base64,${Buffer.from(`const deps = globalThis[${JSON.stringify(key)}];\n${compiled}`).toString('base64')}`) }
  finally { delete globalThis[key] }
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve() }
const track = { id: 'local:C:/Music/a.wav', title: 'A', artist: 'Artist', album: 'Album', duration_ms: 1000, url: 'C:/Music/a.wav', cover_url: 'C:/Music/a.png', source: 'local', sync_payload: { sourceStableKey: 'online:1' } }
globalThis.navigator ??= { platform: 'Win32' }

async function runtime(options = {}) {
  const storage = new Map(options.storage || [])
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }
  const events = new Map(), calls = []
  const backend = { folders: options.folders ? [...options.folders] : [], scanning: false }
  const snapshot = () => ({
    folders: backend.folders.map(path => ({ path, addedAt: 1, trackCount: 1, available: true })),
    tracks: backend.folders.length ? [track] : [],
    scanning: backend.scanning,
    skipped: [],
  })
  const module = await load({
    pinia, vue,
    '@tauri-apps/api/core': { convertFileSrc: path => `asset:${path}`, invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'local_library_snapshot') return snapshot()
      if (command === 'local_library_add_folder') {
        if (options.addFailure) throw new Error('fixture inaccessible folder')
        if (!backend.folders.includes(args.path)) backend.folders.push(args.path)
        backend.scanning = true
        return snapshot()
      }
      if (command === 'local_library_remove_folder') {
        backend.folders = backend.folders.filter(path => path !== args.path)
        return snapshot()
      }
      if (command === 'local_library_rescan') { backend.scanning = true; return snapshot() }
      if (command === 'get_local_playlist_tracks') return [track]
      if (command === 'edit_local_file_tags' && options.editFailure) throw new Error('fixture write failure')
    } },
    '@tauri-apps/api/event': { listen: async (name, callback) => {
      events.set(name, callback)
      return () => events.delete(name)
    } },
    './settings': { useSettingsStore: () => ({ downloadNameTemplate: '{title}' }) },
    './player': { usePlayerStore: () => ({ withReleasedAudioFile: async (path, operation) => {
      calls.push({ command: 'releaseAudioFile', args: { path } })
      if (options.release) await options.release.promise
      return operation()
    }, updateCurrentTrackInfo() {} }) },
    '@/utils/logger': { createLogger: () => ({ error() {}, warn() {} }) },
  })
  pinia.setActivePinia(pinia.createPinia())
  return { store: module.useLibraryStore(), calls, events, storage, backend }
}

{
  // 启动时只读索引，不触发整夹扫描；旧版「上次扫描目录」被收编为音乐文件夹后清除
  const r = await runtime({ storage: [['neri:last_scan_dir', 'C:/Music']] })
  await r.store.ensureStarted()
  assert.equal(r.store.folders.length, 1)
  assert.equal(r.store.folders[0].path, 'C:/Music')
  assert.equal(r.storage.has('neri:last_scan_dir'), false)
  assert.equal(r.store.tracks[0].coverUrl, 'asset:C:/Music/a.png')
  assert.deepEqual(r.store.tracks[0].syncPayload, { sourceStableKey: 'online:1' })
  assert.ok(['local-library-changed', 'local-library-progress'].every(name => r.events.has(name)))
  assert.ok(r.calls.every(item => !/create_playlist|add.*playlist|remove.*playlist/.test(item.command)), 'indexing must never modify playlists')
  await r.store.ensureStarted()
  assert.equal(r.calls.filter(item => item.command === 'local_library_snapshot').length, 1, 'startup runs once')
}
{
  // 后端监视到变化后广播，前端跟着刷新；进度事件只更新状态
  const r = await runtime({ folders: ['C:/Music'] })
  await r.store.ensureStarted()
  r.events.get('local-library-progress')({ payload: { folder: 'C:/Music', visitedEntries: 100, tracks: 12, skipped: 1, currentPath: 'C:/Music/a.wav' } })
  assert.equal(r.store.isScanning, true)
  assert.equal(r.store.scanProgress.tracks, 12)
  r.events.get('local-library-changed')()
  await flush()
  assert.equal(r.store.isScanning, false)
  assert.equal(r.store.scanProgress, null)
}
{
  const r = await runtime({ addFailure: true })
  await r.store.ensureStarted()
  await assert.rejects(r.store.addFolder('Z:/Missing'), /inaccessible/)
  assert.match(r.store.scanError, /inaccessible/)
  assert.equal(r.store.folders.length, 0)
}
{
  const r = await runtime()
  await r.store.ensureStarted()
  await r.store.addFolder('C:/Music')
  assert.equal(r.store.isScanning, true)
  await r.store.removeFolder('C:/Music')
  assert.equal(r.store.tracks.length, 0)
}
{
  const r = await runtime({ folders: ['C:/Music'], editFailure: true })
  await r.store.ensureStarted()
  await assert.rejects(r.store.saveTrackTags(r.store.tracks[0], { title: 'New', artist: 'Artist', album: 'Album' }), /fixture write failure/)
  assert.equal(r.store.tracks[0].title, 'A')
  assert.equal(r.store.isSavingTags, false)
}
{
  const r = await runtime({ folders: ['C:/Music'] })
  await r.store.ensureStarted()
  await r.store.saveTrackTags(r.store.tracks[0], { title: 'New', artist: 'Artist', album: 'Album' })
  assert.equal(r.store.tracks[0].title, 'New')
  assert.equal(r.calls.find(item => item.command === 'edit_local_file_tags').args.scanRoot, 'C:/Music')
  await assert.rejects(r.store.saveTrackTags({ ...r.store.tracks[0], audioUrl: 'D:/Elsewhere/a.wav' }, { title: 'New', artist: 'Artist', album: 'Album' }), /no longer/)
}
{
  const release = deferred(), r = await runtime({ folders: ['C:/Music'], release })
  await r.store.ensureStarted()
  const writing = r.store.saveTrackTags(r.store.tracks[0], { title: 'New', artist: 'Artist', album: 'Album' })
  await flush()
  assert.equal(r.calls.some(call => call.command === 'edit_local_file_tags'), false, 'tag writing must wait for decoder release')
  release.resolve(); await writing
  assert.deepEqual(r.calls.filter(call => ['releaseAudioFile', 'edit_local_file_tags'].includes(call.command)).map(call => call.command), ['releaseAudioFile', 'edit_local_file_tags'])
}
console.log('local library store lifecycle tests passed')
