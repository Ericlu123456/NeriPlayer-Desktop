import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import { compileStyleAsync, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const source = await readFile(new URL('../src/views/TrayPopupView.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const parsed = ts.createSourceFile('TrayPopupView.ts', script, ts.ScriptTarget.ES2022, true)
const statements = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(parsed)).join('\n')
const compiled = ts.transpileModule(statements, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function snapshot(title, dark = true) {
  return {
    locale: 'en',
    track: { title, artist: 'Artist', coverUrl: '' },
    theme: { dark, vars: { '--md-surface-container': dark ? 'rgb(33, 31, 38)' : 'rgb(241, 237, 243)' } },
    isPlaying: true,
    desktopLyricsOpen: false,
  }
}

function runtime() {
  let mounted, unmounted
  const events = new Map(), classes = new Set(), properties = new Map(), calls = []
  const initial = deferred(), waitingForSnapshot = deferred()
  const root = {
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    style: { setProperty: (name, value) => properties.set(name, value) },
  }
  const dependencies = {
    computed: vue.computed,
    nextTick: vue.nextTick,
    ref: vue.ref,
    watch: vue.watch,
    onMounted: callback => { mounted = callback },
    onUnmounted: callback => { unmounted = callback },
    useI18n: () => ({ t: key => key }),
    setLocale: () => {},
    isTauri: () => true,
    listen: async (event, callback) => { events.set(event, callback); return () => events.delete(event) },
    invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'get_tray_popup_state') {
        waitingForSnapshot.resolve()
        return initial.promise
      }
    },
    document: { documentElement: root },
    window: { innerWidth: 300, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
  }
  const actual = new Function(...Object.keys(dependencies), `${compiled}\nreturn { state, cardRef }`)(...Object.values(dependencies))
  return { ...actual, mounted: () => mounted(), unmounted: () => unmounted(), initial, waitingForSnapshot, events, classes, properties, calls }
}

let failures = 0
async function test(name, run) {
  try { await run(); console.log(`passed: ${name}`) }
  catch (error) { failures++; console.error(`failed: ${name}: ${error.message}`) }
}

await test('a live tray update stays current when the initial snapshot resolves later', async () => {
  const view = runtime()
  const mount = view.mounted()
  await view.waitingForSnapshot.promise
  view.events.get('tray-popup:state')({ payload: snapshot('New song', false) })
  view.initial.resolve(snapshot('Old song'))
  await mount
  assert.equal(view.state.value.track.title, 'New song')
  assert.equal(view.classes.has('light-theme'), true)
  assert.equal(view.properties.get('--md-surface-container'), 'rgb(241, 237, 243)')
  view.unmounted()
})

await test('unmounting before the initial snapshot resolves prevents late page updates', async () => {
  const view = runtime()
  const mount = view.mounted()
  await view.waitingForSnapshot.promise
  view.unmounted()
  view.initial.resolve(snapshot('Late song', false))
  await mount
  assert.equal(view.state.value.track, null)
  assert.equal(view.classes.has('light-theme'), false)
  assert.equal(view.events.size, 0)
  assert.equal(view.calls.some(call => call.command === 'tray_popup_ready'), false)
})

await test('theme overrides keep tray opacity on the backdrop image', async () => {
  const { descriptor } = parse(source)
  const style = descriptor.styles[0]
  const result = await compileStyleAsync({
    source: style.content,
    filename: 'TrayPopupView.vue',
    id: 'data-v-tray-test',
    scoped: style.scoped,
    preprocessLang: style.lang,
  })
  assert.deepEqual(result.errors, [])
  assert.match(result.code, /html\.light-theme\s+\.tp-hero-backdrop\s+img\s*\{\s*opacity:\s*0\.28/)
  assert.match(result.code, /html\.dark-theme\s+\.tp-item--quit:hover\s*\{/)
  assert.doesNotMatch(result.code, /html\.(?:light|dark)-theme\s*\{/)
})

if (failures) process.exit(1)
