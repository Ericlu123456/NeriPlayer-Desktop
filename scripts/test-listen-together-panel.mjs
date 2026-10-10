import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const panelSource = await readFile(new URL('../src/components/ListenTogetherPanel.vue', import.meta.url), 'utf8')
const panelScript = compileScript(parse(panelSource).descriptor, {
  id: 'listen-together-panel-test', genDefaultAs: 'component', inlineTemplate: true,
})
const compiledPanel = transpile(panelScript.content)
const protocolSource = await readFile(new URL('../src/stores/listenTogether/protocol.ts', import.meta.url), 'utf8')
const protocol = {}
new Function('exports', transpile(protocolSource))(protocol)
const storeSource = await readFile(new URL('../src/stores/listenTogether/index.ts', import.meta.url), 'utf8')
const parsedStore = ts.createSourceFile('listen-together.ts', storeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let nicknameStatement
function findNickname(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(parsedStore) === 'nickname')) {
    nicknameStatement = node.getText(parsedStore)
  }
  ts.forEachChild(node, findNickname)
}
findNickname(parsedStore)
assert.ok(nicknameStatement, 'the real nickname computed must be loaded')
const createNickname = new Function('computed', 'settings', 'userUuid', `${transpile(nicknameStatement)}\nreturn nickname`)

const originalDocument = globalThis.Document
const originalShadowRoot = globalThis.ShadowRoot
globalThis.Document = class Document {}
globalThis.ShadowRoot = class ShadowRoot {}

function mount({ open = true, savedNickname = '' } = {}) {
  const document = new globalThis.Document()
  const listeners = new Map()
  const timers = new Set()
  const window = {
    addEventListener(type, listener) { listeners.set(`window:${type}`, listener) },
    removeEventListener(type) { listeners.delete(`window:${type}`) },
  }
  document.addEventListener = (type, listener) => listeners.set(`document:${type}`, listener)
  document.removeEventListener = type => listeners.delete(`document:${type}`)
  const settings = vue.reactive({ ltNickname: savedNickname })
  const calls = []
  const nickname = createNickname(vue.computed, settings, vue.ref('abcd-1234'))
  const store = vue.reactive({
    nickname, connectionState: 'disconnected', isConnected: false, isController: false,
    roomId: null, roomState: null, role: null, sessionError: null,
    lastSyncEventType: null, lastSyncAt: null, lastReconnectAt: null,
    createRoom: () => calls.push({ action: 'create', nickname: store.nickname }),
    joinRoom: (roomId, secret, baseUrl) => calls.push({ action: 'join', nickname: store.nickname, roomId, secret, baseUrl }),
    checkClipboardInvite: async () => null,
  })
  const wrapper = (_, { slots }) => slots.default?.()
  const dependencies = {
    vue: { ...vue, Transition: wrapper },
    '@/stores/listenTogether': { useListenTogetherStore: () => store },
    '@/stores/listenTogether/protocol': protocol,
    'vue-i18n': { useI18n: () => ({ t: key => key }) },
  }
  const component = new Function('require', 'exports', 'window', 'document', 'setInterval', 'clearInterval', `${compiledPanel}\nreturn component`)(
    name => {
      assert.ok(name in dependencies, `missing component dependency ${name}`)
      return dependencies[name]
    }, {}, window, document,
    callback => { timers.add(callback); return callback }, timer => timers.delete(timer),
  )
  function element(type) {
    return {
      type, tagName: type.toUpperCase(), value: '', children: [], props: {}, events: new Map(),
      ownerDocument: document, getRootNode: () => document,
      addEventListener(type, listener) {
        const handlers = this.events.get(type) ?? []
        handlers.push(listener)
        this.events.set(type, handlers)
      },
      dispatchEvent(event) {
        Object.defineProperty(event, 'target', { value: this })
        for (const listener of this.events.get(event.type) ?? []) listener(event)
      },
    }
  }
  const renderer = vue.createRenderer({
    createElement: element,
    createText: text => ({ text }), createComment: text => ({ text }),
    setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] },
    patchProp(node, key, _, value) { node.props[key] = value; if (key === 'value') node.value = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    querySelector: selector => selector === 'body' ? document.body : null,
    insert(node, parent, anchor = null) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
  })
  const props = vue.reactive({ open })
  const root = { children: [] }
  document.body = root
  const app = renderer.createApp({ setup: () => () => vue.h(component, props) })
  app.mount(root)
  function find(predicate, node = root) {
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const result = find(predicate, child)
      if (result) return result
    }
  }
  const field = id => find(node => node.props?.id === id)
  const buttons = () => {
    const actions = find(node => node.props?.class === 'lt-actions')
    return actions.children.filter(node => node.type === 'button')
  }
  async function input(id, value, event = 'input') {
    const node = field(id)
    document.activeElement = node
    node.value = value
    node.dispatchEvent(new Event(event))
    await vue.nextTick()
    return node
  }
  return {
    store, settings, calls, props, field, buttons, input,
    stop() {
      app.unmount()
      assert.equal(listeners.size, 0, 'unmount must release panel listeners')
      assert.equal(timers.size, 0, 'unmount must release the relative-time timer')
    },
  }
}

let total = 0
let failed = 0
async function test(name, run) {
  total++
  const panel = mount()
  try { await run(panel); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
  finally { panel.stop() }
}

await test('deleting the complete nickname stays empty through unrelated panel updates', async panel => {
  assert.equal(panel.field('lt-nickname').value, 'NERIPCABCD')
  await panel.input('lt-nickname', '')
  panel.store.sessionError = 'an unrelated update'
  await vue.nextTick()
  assert.equal(panel.field('lt-nickname').value, '')
  assert.equal(panel.settings.ltNickname, '')
})

await test('backspacing and typing a replacement never inserts the default nickname', async panel => {
  for (const value of ['NERIPCABC', 'NERIPCA', 'NERI', 'N', '', '小', '小明', '小明2']) {
    await panel.input('lt-nickname', value)
    assert.equal(panel.field('lt-nickname').value, value)
  }
  assert.equal(panel.settings.ltNickname, '小明2')
})

await test('Chinese IME composition is preserved until the finished nickname is committed', async panel => {
  await panel.input('lt-nickname', '')
  const field = panel.field('lt-nickname')
  assert.equal(field.value, '')
  field.dispatchEvent(new Event('compositionstart'))
  await panel.input('lt-nickname', 'zhang')
  panel.store.sessionError = 'an unrelated update during composition'
  await vue.nextTick()
  assert.equal(field.value, 'zhang')
  assert.equal(panel.settings.ltNickname, '')
  await panel.input('lt-nickname', '张三', 'compositionend')
  assert.equal(field.value, '张三')
  assert.equal(panel.settings.ltNickname, '张三')
})

await test('nickname whitespace is kept while editing and normalized when creating a room', async panel => {
  const field = await panel.input('lt-nickname', ' 张三 ')
  field.dispatchEvent(new Event('change'))
  await vue.nextTick()
  assert.equal(field.value, ' 张三 ')
  assert.equal(panel.buttons()[0].props.disabled, false)
  panel.buttons()[0].props.onClick()
  assert.deepEqual(panel.calls, [{ action: 'create', nickname: '张三' }])
})

await test('empty and invalid draft nicknames cannot create or join a room through the store fallback', async panel => {
  await panel.input('lt-invite', 'neriplayer://listen-together/join?roomId=ABC234&secret=testsecret')
  for (const value of ['', '   ', '昵称!']) {
    await panel.input('lt-nickname', value)
    assert.equal(panel.field('lt-nickname').props['aria-invalid'], true)
    assert.equal(panel.field('lt-nickname-hint').text, 'listen_together.invalid_nickname')
    const [create, join] = panel.buttons()
    assert.equal(create.props.disabled, true)
    assert.equal(join.props.disabled, true)
    create.props.onClick()
    join.props.onClick()
    assert.deepEqual(panel.calls, [])
  }
})

await test('a valid replacement nickname joins with the trimmed value and invitation details', async panel => {
  await panel.input('lt-nickname', ' 小明2 ')
  await panel.input('lt-invite', 'neriplayer://listen-together/join?roomId=ABC234&secret=testsecret')
  assert.equal(panel.buttons()[1].props.disabled, false)
  panel.buttons()[1].props.onClick()
  assert.deepEqual(panel.calls, [{ action: 'join', nickname: '小明2', roomId: 'ABC234', secret: 'testsecret', baseUrl: undefined }])
})

await test('submitting immediately after input uses the current draft before the persistence watcher runs', async panel => {
  const field = panel.field('lt-nickname')
  field.value = ' 李四 '
  field.dispatchEvent(new Event('input'))
  panel.buttons()[0].props.onClick()
  assert.deepEqual(panel.calls, [{ action: 'create', nickname: '李四' }])
  await vue.nextTick()
})

await test('reopening the panel picks up a nickname changed elsewhere without replacing an active draft', async panel => {
  await panel.input('lt-nickname', '')
  panel.store.nickname = '外部修改'
  await vue.nextTick()
  assert.equal(panel.field('lt-nickname').value, '')
  panel.props.open = false
  await vue.nextTick()
  panel.store.nickname = '新的昵称'
  panel.props.open = true
  await vue.nextTick()
  assert.equal(panel.field('lt-nickname').value, '新的昵称')
})

globalThis.Document = originalDocument
globalThis.ShadowRoot = originalShadowRoot
console.log(`Listen-together panel regressions: ${total - failed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
