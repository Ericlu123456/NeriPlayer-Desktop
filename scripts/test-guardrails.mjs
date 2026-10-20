// 架构与卫生门禁：拦截“让检查闭嘴”的常见写法
// Architecture and hygiene guardrails: block the usual ways checks get silenced.
//
// 这里只放确定性高、误报低的规则；需要例外时改 allowlist，而不是放宽规则。
// Only deterministic, low-false-positive rules live here. Add an allowlist entry
// instead of weakening a rule.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')
const failures = []

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const sourceFiles = walk(path.join(root, 'src')).filter((file) => /\.(ts|vue)$/.test(file))

// 1) 禁止把类型检查关掉 / Type checks may not be silenced.
const forbiddenDirectives = [
  { pattern: /@ts-ignore/, label: '@ts-ignore' },
  { pattern: /@ts-nocheck/, label: '@ts-nocheck' },
  { pattern: /@ts-expect-error/, label: '@ts-expect-error' },
]
for (const file of sourceFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const { pattern, label } of forbiddenDirectives) {
      if (pattern.test(line)) failures.push(`${path.relative(root, file)}:${index + 1}: ${label}`)
    }
  })
}

// 2) 禁止 console.log；前端统一走 createLogger / console.log is banned, use createLogger.
for (const file of sourceFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (/\bconsole\.log\s*\(/.test(line)) failures.push(`${path.relative(root, file)}:${index + 1}: console.log`)
  })
}

// 3) 禁止用 #[allow(dead_code)] 掩盖死代码；只允许 security.rs 里两个测试辅助。
//    dead_code may not be silenced; only the two test-only security helpers are allowed.
const rustFiles = walk(path.join(root, 'src-tauri', 'src')).filter((file) => file.endsWith('.rs'))
const deadCodeAllowed = new Set(['src-tauri/src/security.rs'])
for (const file of rustFiles) {
  const relative = path.relative(root, file)
  if (deadCodeAllowed.has(relative)) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (/#\[allow\(dead_code\)\]/.test(line)) failures.push(`${relative}:${index + 1}: #[allow(dead_code)]`)
  })
}

// 4) 禁止用 re-export 垫片续命旧路径；旧路径应直接迁移。
//    Re-export shims keeping old paths alive are banned; migrate imports instead.
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const nonComment = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .trim()
  if (/^export\s+\*\s+from\s+['"]@\/modules\//.test(nonComment) && nonComment.split('\n').length <= 2) {
    failures.push(`${path.relative(root, file)}: re-export shim for a moved module`)
  }
}

// 5) 四份语言文件必须键集一致，避免只给中文加键 / all locales must share one key set.
function flatten(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const pathKey = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, pathKey, out)
    else out[pathKey] = child
  }
  return out
}

const locales = ['zh-CN', 'zh-TW', 'en', 'ja']
const localeKeys = new Map()
for (const locale of locales) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'src', 'i18n', `${locale}.json`), 'utf8'))
  localeKeys.set(locale, new Set(Object.keys(flatten(data))))
}
const baseline = localeKeys.get('zh-CN')
for (const locale of locales.slice(1)) {
  const keys = localeKeys.get(locale)
  for (const key of baseline) if (!keys.has(key)) failures.push(`i18n/${locale}.json: missing key ${key}`)
  for (const key of keys) if (!baseline.has(key)) failures.push(`i18n/${locale}.json: extra key ${key}`)
}

if (failures.length > 0) {
  console.error('Guardrail violations:')
  for (const failure of failures.sort()) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('guardrails: type directives, logging, dead_code allows, shims and locale parity clean')
}
