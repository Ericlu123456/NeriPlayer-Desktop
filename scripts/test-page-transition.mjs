import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compile } from 'sass'

const postcss = createRequire(import.meta.resolve('vite'))('postcss')
const css = postcss.parse(compile(fileURLToPath(new URL('../src/styles/global.scss', import.meta.url))).css)

function transitionStyle(state, rootClasses) {
  const selectors = new Set([
    `.${state}`,
    ...rootClasses.map(name => `html.${name} .${state}`),
  ])
  const style = {}
  css.each(rule => {
    if (rule.type !== 'rule' || !rule.selectors.some(selector => selectors.has(selector))) return
    rule.walkDecls(declaration => { style[declaration.prop] = declaration.value })
  })
  return style
}

for (const platform of ['windows', 'mac', 'linux']) {
  const root = [`platform-${platform}`]
  const entering = transitionStyle('fade-enter-from', root)
  const leaving = transitionStyle('fade-leave-to', root)
  assert.equal(entering.opacity, '0')
  assert.equal(entering.transform, 'translateY(8px) scale(0.98)', `${platform} keeps the original page zoom-in`)
  assert.equal(leaving.opacity, '0')
  assert.equal(leaving.transform, 'scale(0.99)', `${platform} keeps the original page zoom-out`)
  for (const state of ['fade-enter-active', 'fade-leave-active']) {
    const { transition } = transitionStyle(state, root)
    assert.match(transition, /(?:^|,\s*)opacity /)
    assert.match(transition, /(?:^|,\s*)transform /)
  }
}

console.log('page transition styles passed: original motion on all three platforms')
