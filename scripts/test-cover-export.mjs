import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const component = await readFile(new URL('../src/components/NowPlaying.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const parsed = ts.createSourceFile('now-playing.ts', script, ts.ScriptTarget.ES2022, true)
const functions = ['readCoverBytes', 'imageExtension'].map(name => {
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name)
  assert.ok(node, `missing cover export declaration: ${name}`)
  return node.getText(parsed)
}).join('\n')
const cacheSource = await readFile(new URL('../src/utils/bilibiliCoverCache.ts', import.meta.url), 'utf8')
const compiledCache = ts.transpileModule(cacheSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
const { normalizeProxiedCoverUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiledCache).toString('base64')}`)
const fetched = [], proxied = []
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const { readCoverBytes, imageExtension } = new Function('resolveCoverImage', 'normalizeProxiedCoverUrl', 'fetch', `${compiled}; return { readCoverBytes, imageExtension }`)(
  async url => {
    if (!normalizeProxiedCoverUrl(url)) throw new Error('Cover URL is invalid')
    proxied.push(url)
    return `data:image/png;base64,${btoa('fixture-png')}`
  },
  normalizeProxiedCoverUrl,
  async url => {
    fetched.push(url)
    return { ok: true, blob: async () => new Blob(['fixture-local'], { type: 'image/webp' }) }
  },
)

const local = await readCoverBytes('http://asset.localhost/C%3A/Music/cover.webp')
assert.equal(local.extension, 'webp')
assert.equal(new TextDecoder().decode(local.bytes), 'fixture-local')
assert.deepEqual(proxied, [], 'local asset addresses must bypass the online cover allowlist')
assert.equal((await readCoverBytes('asset://localhost/Music/cover.webp')).extension, 'webp')
assert.equal((await readCoverBytes('https://p1.music.126.net/fixture.png')).extension, 'png')
assert.equal(proxied.length, 1)
assert.equal((await readCoverBytes(`data:image/jpeg;base64,${btoa('fixture-jpeg')}`)).extension, 'jpg')
assert.equal(fetched.length, 2, 'proxied and inline covers do not fall through to browser fetch')
assert.equal(imageExtension('PNG'), 'png')
console.log('local asset, online proxy and inline cover export tests passed')
