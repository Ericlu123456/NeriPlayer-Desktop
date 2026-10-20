// rustfmt 门禁：已格式化的文件必须保持格式化，新文件必须格式化
// rustfmt gate: already-clean files must stay clean and new files must be clean.
//
// 不搞一次性全量重排：仓库历史上有大量未格式化的文件，直接 cargo fmt 会淹没真实改动。
// 这里对每个改动文件先看基线版本是否本来就通过 rustfmt——本来就脏的文件只要求不变得更脏，
// 本来干净的文件和新文件则必须继续通过。
// No big-bang reformat: much of the history predates rustfmt, so `cargo fmt` would bury
// real changes. For every changed file we first check whether the base revision was
// already rustfmt-clean; dirty legacy files may stay dirty, clean files and new files
// must pass.
//
// 用法 / Usage:
//   BASE_SHA=<commit> node scripts/check-rust-fmt.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  return result.stdout
}

function rustfmtCheck(filePath) {
  const result = spawnSync('rustfmt', ['--edition', '2021', '--check', filePath], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() }
}

let base = (process.env.BASE_SHA || process.env.GITHUB_EVENT_BEFORE || '').trim()
if (!base || /^0+$/.test(base)) {
  try {
    base = git(['rev-parse', 'HEAD^']).trim()
  } catch {
    console.log('rustfmt: no base commit available, skipping (bootstrap push)')
    process.exit(0)
  }
}

let changed
try {
  changed = git(['diff', '--name-status', '--diff-filter=ACMR', base, 'HEAD', '--', '*.rs'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status, file: rest.join('\t') }
    })
} catch (error) {
  console.error(`rustfmt: could not diff against ${base}: ${error.message}`)
  process.exit(1)
}

if (changed.length === 0) {
  console.log('rustfmt: no Rust files changed')
  process.exit(0)
}

const failures = []
let checked = 0
let skippedLegacy = 0
const scratchRoot = path.join(root, '.cache', 'rustfmt')
fs.mkdirSync(scratchRoot, { recursive: true })
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'neri-rustfmt-'))

try {
  for (const { status, file } of changed) {
    const wasAdded = status === 'A'
    if (wasAdded) {
      checked += 1
      const result = rustfmtCheck(file)
      if (!result.ok) failures.push({ file, output: result.output })
      continue
    }

    let baseSource
    try {
      baseSource = git(['show', `${base}:${file}`])
    } catch {
      skippedLegacy += 1
      continue
    }
    const scratchFile = path.join(scratch, path.basename(file))
    fs.writeFileSync(scratchFile, baseSource)
    if (!rustfmtCheck(scratchFile).ok) {
      skippedLegacy += 1
      continue
    }

    checked += 1
    const result = rustfmtCheck(file)
    if (!result.ok) failures.push({ file, output: result.output })
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('rustfmt: files that were formatted before (or are new) are no longer formatted:')
  for (const { file, output } of failures) {
    console.error(`  - ${file}`)
    if (output) console.error(output)
  }
  process.exit(1)
}

console.log(
  `rustfmt: ${checked} file(s) checked, ${skippedLegacy} legacy file(s) already unformatted at base`,
)
