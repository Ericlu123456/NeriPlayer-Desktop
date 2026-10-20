// 死代码门禁：入口可达性 + 只声明未被引用的导出
// Dead-code gate: entry reachability plus exports that are declared but never referenced.
//
// 为什么需要它 / Why this exists:
// - Rust 的 dead_code 不覆盖 pub 项，TypeScript 也不检查未使用的导出；两者叠加会让
//   “重构后留下的垫片、无人调用的命令、整块废弃特性”长期潜伏。
//   Rust's dead_code lint never covers pub items and TypeScript never checks unused
//   exports, so post-refactor shims, orphaned commands and retired features can rot
//   silently for months.
// - 这个脚本只做高置信判断：从入口不可达的文件，以及“只出现在声明处一次”的导出。
//   It only reports high-confidence findings: files unreachable from the app entry and
//   exports whose name occurs exactly once in its own file and nowhere else.
//
// 例外请写进 scripts/dead-code-allowlist.json，而不是删检查。
// Put intentional exceptions in scripts/dead-code-allowlist.json; do not delete the check.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')
const srcDir = path.join(root, 'src')
const allowlistPath = path.join(scriptDir, 'dead-code-allowlist.json')

const allowlist = fs.existsSync(allowlistPath)
  ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
  : { files: [], exports: [] }
const allowedFiles = new Set(allowlist.files ?? [])
const allowedExports = new Set(allowlist.exports ?? [])

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(srcDir)
const sourceFiles = files.filter((file) => /\.(ts|vue|js|mjs)$/.test(file) && !file.endsWith('.d.ts'))
const probeFiles = files.filter((file) =>
  /\.(ts|vue|js|mjs|scss|css|json|vert|frag)$/.test(file) && !file.endsWith('.d.ts'),
)

const extensions = ['.ts', '.vue', '.js', '.mjs', '.json', '.scss', '.css', '.vert', '.frag']

function resolveSpecifier(specifier, importer) {
  let base
  if (specifier.startsWith('@/')) base = path.join(srcDir, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(importer), specifier)
  else return null
  base = base.replace(/[?#].*$/, '')
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const extension of extensions) {
    if (fs.existsSync(base + extension)) return base + extension
  }
  for (const extension of extensions) {
    const index = path.join(base, `index${extension}`)
    if (fs.existsSync(index)) return index
  }
  return null
}

const importPattern =
  /(?:^|[^\w$.])(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const sassPattern = /@(use|import|forward)\s+['"]([^'"]+)['"]/g
const vueStyleSrcPattern = /<style[^>]*\bsrc=["']([^"']+)["']/g

const references = new Map()
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const targets = new Set()
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1] || match[2] || match[3]
    if (!specifier) continue
    const resolved = resolveSpecifier(specifier, file)
    if (resolved) targets.add(resolved)
  }
  if (/\.(vue|scss|css)$/.test(file)) {
    for (const match of text.matchAll(sassPattern)) {
      const resolved = resolveSpecifier(match[2], file)
      if (resolved) targets.add(resolved)
    }
  }
  if (file.endsWith('.vue')) {
    for (const match of text.matchAll(vueStyleSrcPattern)) {
      const resolved = resolveSpecifier(match[1], file)
      if (resolved) targets.add(resolved)
    }
  }
  references.set(file, targets)
}

const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
const entryFiles = [path.join(srcDir, 'main.ts')]
for (const match of indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
  const entry = path.resolve(root, match[1].replace(/^\.\//, ''))
  if (fs.existsSync(entry)) entryFiles.push(entry)
}

const reachable = new Set()
const queue = [...entryFiles]
while (queue.length > 0) {
  const file = queue.pop()
  if (reachable.has(file)) continue
  reachable.add(file)
  for (const target of references.get(file) ?? []) queue.push(target)
}

const unreachable = probeFiles
  .filter((file) => !reachable.has(file))
  .map((file) => path.relative(root, file))
  .filter((file) => !allowedFiles.has(file))
  .sort()

// 导出引用统计：同一文件内只剩声明本身、其他文件完全没提到，视为死导出。
// Export usage: a name that appears exactly once in its own file and nowhere else.
const ownText = new Map()
for (const file of sourceFiles) ownText.set(file, fs.readFileSync(file, 'utf8'))
const otherText = [...ownText.entries()].map(([file, text]) => ({ file, text }))
for (const file of walk(path.join(root, 'scripts'))) {
  if (file.endsWith('.mjs')) otherText.push({ file, text: fs.readFileSync(file, 'utf8') })
}

const deadExports = []
for (const [file, raw] of ownText) {
  let code = raw
  if (file.endsWith('.vue')) {
    code = [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
  }
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS)
  for (const statement of source.statements) {
    const modifiers = statement.modifiers ?? []
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue
    const names = []
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      names.push(statement.name.text)
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.push(element.name.text)
    }
    for (const name of names) {
      const identifier = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g')
      const ownCount = (code.match(identifier) ?? []).length
      if (ownCount !== 1) continue
      identifier.lastIndex = 0
      const referencedElsewhere = otherText.some((entry) => {
        if (entry.file === file) return false
        identifier.lastIndex = 0
        return identifier.test(entry.text)
      })
      if (referencedElsewhere) continue
      const key = `${path.relative(root, file)}:${name}`
      if (!allowedExports.has(key)) deadExports.push(key)
    }
  }
}
deadExports.sort()

if (unreachable.length > 0 || deadExports.length > 0) {
  if (unreachable.length > 0) {
    console.error('Unreachable files from the app entry (delete them or allowlist them):')
    for (const file of unreachable) console.error(`  - ${file}`)
  }
  if (deadExports.length > 0) {
    console.error('Exports declared but never referenced (delete them or allowlist them):')
    for (const entry of deadExports) console.error(`  - ${entry}`)
  }
  process.exitCode = 1
} else {
  console.log(`dead-code: ${probeFiles.length} files reachable, no dead exports`)
}
