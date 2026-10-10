import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import ts from 'typescript'

const component = await readFile(new URL('../src/components/debug/DebugLogViewer.vue', import.meta.url), 'utf8')
const source = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]

function runtime(invoke) {
  const mounted = [], unmounted = [], intervals = new Map()
  let nextTimer = 0
  const dependencies = {
    vue: { ...vue, onMounted: hook => mounted.push(hook), onUnmounted: hook => unmounted.push(hook) },
    'vue-i18n': { useI18n: () => ({ t: key => key }) },
    '@tauri-apps/api/core': { invoke },
    '@tauri-apps/plugin-clipboard-manager': { writeText: async () => {} },
    '@/stores/toast': { useToastStore: () => ({ success() {} }) },
    '@/utils/logger': { createLogger: () => ({ error() {} }) },
  }
  const compiled = ts.transpileModule(`${source}\nexport { entries, sameEntries, refresh, entryKey }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  const scope = vue.effectScope()
  scope.run(() => new Function('require', 'exports', 'window', 'document', compiled)(
    name => { assert.ok(name in dependencies, `missing dependency ${name}`); return dependencies[name] },
    exports,
    { setInterval: callback => { intervals.set(++nextTimer, callback); return nextTimer }, clearInterval: id => intervals.delete(id) },
    { visibilityState: 'visible' },
  ))
  return { ...exports, mounted, unmounted, intervals, dispose() { for (const hook of unmounted) hook(); scope.stop() } }
}

const entry = (time, message) => ({ timestamp_ms: time, level: 'INFO', target: 'fixture', message })
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function flush() { for (let index = 0; index < 8; index++) { await Promise.resolve(); await vue.nextTick() } }

let failed = 0
async function test(name, run) {
  try { await run(); console.log(`passed: ${name}`) }
  catch (error) { failed++; console.error(`failed: ${name}`, error.message) }
}

await test('log snapshots compare every displayed field even when timestamps collide', () => {
  const r = runtime(async () => [])
  try {
    r.entries.value = [entry(100, 'first'), entry(100, 'middle'), entry(100, 'last')]
    assert.equal(r.sameEntries(r.entries.value.map(item => ({ ...item }))), true)
    for (const [index, field, value] of [[0, 'message', 'replaced'], [1, 'message', 'new'], [2, 'target', 'other'], [0, 'level', 'ERROR']]) {
      const next = r.entries.value.map(item => ({ ...item }))
      next[index][field] = value
      assert.equal(r.sameEntries(next), false, `changed ${field} at ${index} must refresh the list`)
    }
  } finally { r.dispose() }
})

await test('leaving the log page during its first request cannot leave a polling timer', async () => {
  const pending = deferred()
  const r = runtime(() => pending.promise)
  r.mounted[0]()
  r.dispose()
  pending.resolve([entry(100, 'finished after unmount')])
  await flush()
  assert.equal(r.intervals.size, 0)
  assert.equal(r.entries.value.length, 0, 'unmounted views ignore late snapshots')
})

await test('log row identity survives eviction of another row from the same millisecond', () => {
  const r = runtime(async () => [])
  try {
    r.entries.value = [entry(100, 'first'), entry(100, 'kept'), entry(200, 'last')]
    const keptKey = r.entryKey(r.entries.value[1])
    r.entries.value = [entry(100, 'kept'), entry(100, 'new'), entry(200, 'last')]
    assert.equal(r.entryKey(r.entries.value[0]), keptKey)
    assert.notEqual(r.entryKey(r.entries.value[1]), keptKey)
  } finally { r.dispose() }
})

await test('slow log requests do not overlap on interval ticks', async () => {
  const pending = deferred()
  let requests = 0
  const r = runtime(() => { requests++; return pending.promise })
  r.mounted[0]()
  void r.refresh()
  void r.refresh()
  pending.resolve([])
  await flush()
  try { assert.equal(requests, 1) } finally { r.dispose() }
})

assert.equal(failed, 0, `${failed} log viewer regressions failed`)
