import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadModule(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const key = `current-lyrics-test-${Math.random()}`
  globalThis[key] = dependencies
  compiled = compiled.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g, (_, bindings, specifier) => {
    assert.ok(specifier in dependencies, `unexpected dependency ${specifier}`)
    return `const { ${bindings.replace(/\bas\b/g, ':')} } = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}];`
  })
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  } finally {
    delete globalThis[key]
  }
}

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const watchers = []
function trigger() {
  for (const watcher of watchers) {
    const next = watcher.source()
    if (next === watcher.last) continue
    watcher.last = next
    watcher.callback(next)
  }
}
const vue = {
  ref: value => ({ value }),
  shallowRef: value => ({ value }),
  watch: (source, callback) => { watchers.push({ source, callback, last: source() }); return () => {} },
}
const pinia = {
  defineStore: (_, setup) => {
    let store
    return () => {
      if (store) return store
      const raw = setup()
      store = {}
      for (const [name, value] of Object.entries(raw)) {
        if (value && typeof value === 'object' && 'value' in value) {
          Object.defineProperty(store, name, { get: () => value.value, set: next => { value.value = next } })
        } else {
          store[name] = value
        }
      }
      return store
    }
  },
}

const line = (startMs, text, words = []) => ({ startMs, durationMs: 1000, text, words })
const plain = [line(1000, '第一行'), line(2000, '第二行')]
const wordTimed = [
  line(1000, '第一行', [{ startMs: 1000, durationMs: 500, text: '第一' }, { startMs: 1500, durationMs: 500, text: '行' }]),
  line(2000, '第二行', [{ startMs: 2000, durationMs: 1000, text: '第二行' }]),
]

const player = { hasPlaybackSession: true, currentTrack: { id: 'netease:1', title: '歌', artist: '人', durationMs: 0 } }
const settings = { defaultLyricSource: 'automatic', preferWordTimedLyrics: true }
const sources = new Map()
let payloadState = { kind: 'absent' }
let synced = null
let cached = null
const cacheWrites = []
let automatic = []
let wordTimedRequests = []

const { useCurrentLyricsStore } = await loadModule('../src/stores/currentLyrics.ts', {
  pinia,
  vue,
  '@tauri-apps/api/core': { invoke: async () => [] },
  '@/stores/player': { usePlayerStore: () => player },
  '@/stores/settings': { useSettingsStore: () => settings },
  '@/modules/lyrics/lyricsCache': {
    getCachedLyrics: async () => cached,
    saveCachedLyrics: async (track, lines) => { cacheWrites.push([track.id, lines]) },
  },
  '@/modules/lyrics/lyricsRequest': {
    hasWordTimedLyrics: lines => lines.some(entry => entry.words.some(word => word.durationMs > 0)),
    loadLyricsSingleFlight: (_, loader) => loader(),
  },
  '@/modules/lyrics/lyricsFormat': {
    mapBackendLyrics: value => value,
    materializeStoredLyrics: async () => synced,
    mergeParsedLyricsWithRomanization: value => value,
    mergeWordTimedLyricsWithBaseline: (_, upgrade) => upgrade,
    resolveKnownNeteaseLyricSongId: () => null,
    resolveStoredLyricStateFromPayload: () => payloadState,
    shouldBackfillNeteaseRomanization: () => false,
  },
  '@/modules/lyrics/lyricOffset': { normalizeLyricSource: value => value, readSyncedLyricSource: () => 'CLOUD_MUSIC' },
  '@/modules/lyrics/lyricsFetch': {
    fetchAutomaticLyrics: async () => {
      const request = deferred()
      automatic.push(request)
      return request.promise
    },
    fetchNeteaseRomanization: async () => null,
    fetchPreferredSourceLyrics: async () => null,
    fetchWordTimedLyrics: async () => {
      const request = deferred()
      wordTimedRequests.push(request)
      return request.promise
    },
    preferredLyricMatchSource: () => null,
  },
  '@/modules/lyrics/lyricSource': {
    lyricSourceOf: track => sources.get(track.id) ?? null,
    rememberLyricSource: (track, source) => { if (source) sources.set(track.id, source); else sources.delete(track.id) },
  },
  '@/modules/playback/playbackSource': { getPlaybackSourceKind: track => track.id.split(':')[0] },
  '@/modules/playback/playbackRequest': {
    playbackSessionTrackKey: (has, playlistKey, id) => (has && id ? playlistKey || id : 'empty'),
  },
  '@/utils/logger': { createLogger: () => ({ warn() {}, error() {}, info() {} }) },
  '@/utils/logSanitizer': { summarizeLogError: String },
})

const store = useCurrentLyricsStore()
assert.equal(automatic.length, 0, '没有界面用到时不取词')

// 正在播放页打开：取到逐行歌词后后台换上逐字版本，来源记成 AMLL，偏移按它算
const releasePage = store.acquire()
await flush()
assert.equal(store.loading, true)
automatic[0].resolve({ source: 'netease', lines: plain })
await flush()
assert.deepEqual(store.lines, plain)
assert.equal(sources.get('netease:1'), 'netease')
assert.equal(wordTimedRequests.length, 1, '没有逐字时间轴时后台升级')
// 起播后才补上时长：仍是同一首歌，升级结果不能被丢掉（应用内看不到逐字效果的原因）
player.currentTrack = { ...player.currentTrack, durationMs: 215_000 }
trigger()
wordTimedRequests[0].resolve({ source: 'amll_ttml', lines: wordTimed })
await flush()
assert.deepEqual(store.lines, wordTimed, '逐字升级在时长更新后仍然生效')
assert.equal(sources.get('netease:1'), 'amll_ttml', '默认偏移跟着换成逐字歌词的来源')
assert.equal(store.loading, false)
assert.equal(automatic.length, 1, '同一首歌不重复取词')

// 桌面歌词再打开：直接拿同一份，不另取
const releaseDesktop = store.acquire()
await flush()
assert.equal(automatic.length, 1)
assert.deepEqual(store.lines, wordTimed)

// 用户编辑后，进行中的升级不能把编辑盖回去
player.currentTrack = { id: 'netease:2', title: '另一首', artist: '人', durationMs: 1000 }
trigger()
await flush()
assert.deepEqual(store.lines, [], '换歌立即撤下旧词')
automatic[1].resolve({ source: 'netease', lines: plain })
await flush()
const edited = [line(500, '我改的')]
store.replace(edited)
wordTimedRequests[1].resolve({ source: 'amll_ttml', lines: wordTimed })
await flush()
assert.deepEqual(store.lines, edited, '编辑过的歌词不被逐字升级覆盖')

// 切走后旧请求晚到：不能显示在新歌上
player.currentTrack = { id: 'qq:3', title: '第三首', artist: '人', durationMs: 1000 }
trigger()
await flush()
player.currentTrack = { id: 'qq:4', title: '第四首', artist: '人', durationMs: 1000 }
trigger()
await flush()
automatic[2].resolve({ source: 'qq', lines: [line(0, '旧歌')] })
await flush()
assert.deepEqual(store.lines, [])
automatic[3].resolve({ source: 'qq', lines: [line(0, '新歌')] })
await flush()
assert.equal(store.lines[0].text, '新歌')

// 同步载荷里有意清空：不在线回填
synced = []
player.currentTrack = { id: 'netease:5', title: '清空', artist: '人', durationMs: 1000 }
trigger()
await flush()
assert.equal(automatic.length, 4, '有意清空的歌词不联网')
assert.deepEqual(store.lines, [])
synced = null

// 缓存命中：先显示缓存，再升级
cached = plain
player.currentTrack = { id: 'netease:6', title: '缓存', artist: '人', durationMs: 1000 }
trigger()
await flush()
assert.deepEqual(store.lines, plain)
assert.equal(automatic.length, 4, '缓存命中不联网')
assert.equal(wordTimedRequests.length, 4, '缓存缺逐字时同样后台升级')
cached = null

// 两个界面都关了：换歌只清空，不联网；再打开时按当前曲目取
releasePage()
releaseDesktop()
releaseDesktop()
player.currentTrack = { id: 'netease:7', title: '后台', artist: '人', durationMs: 1000 }
trigger()
await flush()
assert.equal(automatic.length, 4, '没有界面时换歌不取词')
assert.deepEqual(store.lines, [])
const releaseAgain = store.acquire()
await flush()
assert.equal(automatic.length, 5, '重新打开时补取当前曲目')
releaseAgain()

console.log('current lyrics store tests passed')
