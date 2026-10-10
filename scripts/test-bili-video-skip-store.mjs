import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as pinia from 'pinia'
import * as vue from 'vue'
import ts from 'typescript'

const path = new URL('../src/stores/biliVideoSkip.ts', import.meta.url)
assert.ok(existsSync(path), 'Bilibili skip interval store is implemented')
function load(relative, dependencies = {}) {
  const result = {}
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'exports', compiled)(name => {
    assert.ok(name in dependencies, `missing dependency ${name}`)
    return dependencies[name]
  }, result)
  return result
}
const policy = load('../src/modules/playback/biliVideoSkip.ts')
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
const target = { bvid: 'BVtest', cid: 101 }, intervals = [{ startMs: 1000, endMs: 5000 }]
const rule = { ...target, intervals, modifiedAt: 100, isDeleted: false }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function runtime({ preloaded = null, persist = async () => rule } = {}) {
  const calls = []
  pinia.setActivePinia(pinia.createPinia())
  const storeModule = load('../src/stores/biliVideoSkip.ts', {
    pinia, vue,
    '@/modules/playback/biliVideoSkip': policy,
    '@/modules/persistence/userData': { preloadedUserData: () => preloaded, persistUserData: (command, args) => { calls.push({ command, args }); return persist(command, args) } },
  })
  return { store: storeModule.useBiliVideoSkipStore(), calls }
}
let cases = 0
async function regression(name, run) { storage.clear(); await run(); cases++; console.log(`ok - ${name}`) }
await regression('preloaded database rules restore page-specific intervals', async () => {
  const { store } = runtime({ preloaded: { biliVideoSkipRules: [rule] } })
  assert.deepEqual(store.ruleFor(target), rule)
  assert.equal(store.ruleFor({ ...target, cid: 102 }), null)
})
await regression('database writes stay invisible until acknowledged and propagate failures', async () => {
  const save = deferred(), { store, calls } = runtime({ preloaded: { biliVideoSkipRules: [] }, persist: () => save.promise })
  const pending = store.setIntervals(target, intervals, 3000)
  assert.equal(store.ruleFor(target), null)
  assert.deepEqual(calls, [{ command: 'set_bili_video_skip_rule', args: { ...target, intervals: [{ startMs: 1000, endMs: 3000 }], durationMs: 3000 } }])
  save.reject(new Error('database failed'))
  await assert.rejects(pending, /database failed/)
  assert.equal(store.ruleFor(target), null)
})
await regression('acknowledged rules replace the target and retain other pages', async () => {
  const other = { ...rule, cid: 102 }, updated = { ...rule, modifiedAt: 200 }
  const { store } = runtime({ preloaded: { biliVideoSkipRules: [other] }, persist: async () => updated })
  assert.deepEqual(await store.setIntervals(target, intervals, 0), updated)
  assert.deepEqual(store.rules, [updated, other])
})
await regression('browser persistence creates deletion tombstones with increasing timestamps', async () => {
  const { store, calls } = runtime()
  const saved = await store.setIntervals(target, intervals)
  const deleted = await store.setIntervals(target, [])
  assert.equal(deleted.isDeleted, true)
  assert.deepEqual(deleted.intervals, [])
  assert.ok(deleted.modifiedAt > saved.modifiedAt)
  assert.equal(store.ruleFor(target), null)
  assert.deepEqual(calls, [])
  assert.deepEqual(runtime().store.rules, [deleted])
})
await regression('unchanged rules and clearing unknown targets do not write', async () => {
  const { store, calls } = runtime({ preloaded: { biliVideoSkipRules: [rule] } })
  assert.deepEqual(await store.setIntervals(target, intervals), rule)
  assert.equal(await store.setIntervals({ ...target, cid: 102 }, []), null)
  assert.deepEqual(calls, [])
})
await regression('browser storage failures leave current rules intact', async () => {
  const { store } = runtime()
  const original = localStorage.setItem
  localStorage.setItem = () => { throw new Error('quota exceeded') }
  await assert.rejects(store.setIntervals(target, intervals), /quota exceeded/)
  assert.deepEqual(store.rules, [])
  localStorage.setItem = original
})
await regression('sync replacement accepts tombstones and refreshes browser persistence', async () => {
  const { store } = runtime()
  store.replaceFromSync([rule, { ...rule, cid: 102, isDeleted: true, intervals: [] }])
  assert.deepEqual(runtime().store.rules, store.rules)
  assert.deepEqual(store.ruleFor(target), rule)
})
await regression('late sync snapshots preserve newer local changes and accept newer remote rules', async () => {
  const local = { ...rule, modifiedAt: 200 }
  const { store } = runtime({ preloaded: { biliVideoSkipRules: [local] } })
  store.replaceFromSync([{ ...rule, modifiedAt: 100, intervals: [{ startMs: 6000, endMs: 8000 }] }])
  assert.deepEqual(store.ruleFor(target), local)
  const remote = { ...rule, modifiedAt: 300, intervals: [{ startMs: 6000, endMs: 8000 }] }
  store.replaceFromSync([remote])
  assert.deepEqual(store.ruleFor(target), remote)
})
await regression('equal-time sync rules follow Android live precedence and interval union', async () => {
  const { store } = runtime({ preloaded: { biliVideoSkipRules: [rule] } })
  store.replaceFromSync([{ ...rule, isDeleted: true, intervals: [] }])
  assert.deepEqual(store.ruleFor(target), rule)
  store.replaceFromSync([{ ...rule, intervals: [{ startMs: 5000, endMs: 8000 }] }])
  assert.deepEqual(store.ruleFor(target).intervals, [{ startMs: 1000, endMs: 8000 }])
})
console.log(`Bilibili skip interval store: ${cases} passed`)
