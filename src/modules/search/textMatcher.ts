// 多权重文本匹配（对齐 Android SearchTextMatcher）：
// 每个候选文本展开成「整串 / 分词 / 紧凑串 / 全拼 / 拼音首字母 / 缩写」等形态，各带偏置；
// 查询按空白拆成多个词，每个词取所有形态里最好的一档（精确 < 前缀 < 包含 < 模糊子序列），
// 总分越低越相关，任何一个词匹配不上就整体不命中
import { pinyin } from 'pinyin-pro'

export interface SearchValue {
  raw: unknown
  bias: number
}

/// 给某个字段加偏置：标题用 0，歌手 / 专辑之类次要字段加大偏置，让标题命中排在前面
export function searchValue(raw: unknown, bias = 0): SearchValue {
  return { raw, bias }
}

interface SearchCandidate {
  text: string
  bias: number
}

const WHOLE_TEXT_BIAS = 0
const SPLIT_TOKEN_BIAS = 2
const COMPACT_TOKEN_BIAS = 4
const PINYIN_FULL_BIAS = 6
const COMPACT_PINYIN_FULL_BIAS = 8
const ACRONYM_BIAS = 10
const PINYIN_INITIALS_BIAS = 12
const COMPACT_PINYIN_INITIALS_BIAS = 14

const PREFIX_MATCH_SCORE = 16
const CONTAINS_MATCH_SCORE = 48
const FUZZY_MATCH_SCORE = 96

const SEPARATOR = /[^\p{L}\p{Nd}]+/u
const HAN = /\p{Script=Han}/u
const COMBINING_MARK = /\p{Mn}/gu
const CACHE_LIMIT = 8000

function isSearchValue(value: unknown): value is SearchValue {
  return typeof value === 'object' && value !== null && 'raw' in value && 'bias' in value
}

function normalizeSearchText(value: string, lowercase = true): string {
  const folded = value.trim().normalize('NFKD').replace(COMBINING_MARK, '').replace(/\u3000/g, ' ')
  return lowercase ? folded.toLowerCase() : folded
}

function splitCamelToken(value: string): string[] {
  if (value.length <= 1) return [value.toLowerCase()]
  const result: string[] = []
  let start = 0
  for (let index = 1; index < value.length; index++) {
    const previous = value[index - 1]
    const current = value[index]
    if (previous !== previous.toUpperCase() && current !== current.toLowerCase()) {
      result.push(value.slice(start, index).toLowerCase())
      start = index
    }
  }
  result.push(value.slice(start).toLowerCase())
  return result
}

/// 中文转「全拼 + 首字母」；按整段转换，多音字能借上下文选对读音。不含汉字时返回 null
function toPinyinToken(value: string): { full: string; initials: string } | null {
  if (!HAN.test(value)) return null
  const chars = [...value]
  const syllables = pinyin(value, { toneType: 'none', type: 'array', nonZh: 'spaced', v: true })
  let full = ''
  let initials = ''
  // 默认模式下每个字符对应一个元素，对不齐时退回逐字转换
  const aligned = syllables.length === chars.length
  chars.forEach((char, index) => {
    if (HAN.test(char)) {
      const syllable = (aligned ? syllables[index] : pinyin(char, { toneType: 'none', v: true })).toLowerCase().trim()
      if (syllable) {
        full += syllable
        initials += syllable[0]
      }
    } else if (/[\p{L}\p{Nd}]/u.test(char)) {
      const lower = char.toLowerCase()
      full += lower
      initials += lower
    }
  })
  return full ? { full, initials } : null
}

const candidateCache = new Map<string, SearchCandidate[]>()

function candidateTokens(value: string): SearchCandidate[] {
  const cached = candidateCache.get(value)
  if (cached) return cached
  const normalized = normalizeSearchText(value)
  let result: SearchCandidate[] = []
  if (normalized) {
    const splitTokens = normalizeSearchText(value, false)
      .split(SEPARATOR)
      .filter(Boolean)
      .flatMap(splitCamelToken)
    const compact = splitTokens.join('')
    const acronym = splitTokens.map(token => [...token][0]).join('')
    const list: SearchCandidate[] = [{ text: normalized, bias: WHOLE_TEXT_BIAS }]
    for (const token of splitTokens) {
      list.push({ text: token, bias: SPLIT_TOKEN_BIAS })
      const py = toPinyinToken(token)
      if (py) {
        list.push({ text: py.full, bias: PINYIN_FULL_BIAS })
        if (py.initials.length > 1) list.push({ text: py.initials, bias: PINYIN_INITIALS_BIAS })
      }
    }
    if (compact) {
      list.push({ text: compact, bias: COMPACT_TOKEN_BIAS })
      const py = toPinyinToken(compact)
      if (py) {
        list.push({ text: py.full, bias: COMPACT_PINYIN_FULL_BIAS })
        if (py.initials.length > 1) list.push({ text: py.initials, bias: COMPACT_PINYIN_INITIALS_BIAS })
      }
    }
    if ([...acronym].length > 1) list.push({ text: acronym, bias: ACRONYM_BIAS })
    const seen = new Set<string>()
    result = list.filter(candidate => {
      const key = `${candidate.text}\u0000${candidate.bias}`
      return !seen.has(key) && !!seen.add(key)
    })
  }
  if (candidateCache.size >= CACHE_LIMIT) candidateCache.clear()
  candidateCache.set(value, result)
  return result
}

function collectCandidates(value: unknown, baseBias: number, out: Map<string, number>): void {
  if (value === null || value === undefined || value === '') return
  if (isSearchValue(value)) {
    collectCandidates(value.raw, baseBias + value.bias, out)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, baseBias, out)
    return
  }
  for (const candidate of candidateTokens(String(value))) {
    const bias = baseBias + candidate.bias
    const previous = out.get(candidate.text)
    if (previous === undefined || bias < previous) out.set(candidate.text, bias)
  }
}

function collapseCandidates(values: unknown[]): SearchCandidate[] {
  const byText = new Map<string, number>()
  collectCandidates(values, 0, byText)
  return [...byText].map(([text, bias]) => ({ text, bias }))
}

function queryTokens(query: string): string[] {
  return normalizeSearchText(query).split(SEPARATOR).filter(Boolean)
}

function subsequenceGapPenalty(text: string, query: string): number | null {
  let queryIndex = 0
  let start = -1
  let end = -1
  for (let index = 0; index < text.length && queryIndex < query.length; index++) {
    if (text[index] === query[queryIndex]) {
      if (start < 0) start = index
      end = index
      queryIndex++
    }
  }
  if (queryIndex !== query.length || start < 0) return null
  return end - start + 1 - query.length
}

const ASCII_TOKEN = /^[a-z0-9]+$/

function allowsFuzzySubsequence(query: string, text: string, gapPenalty: number): boolean {
  // 纯 ASCII 才收紧：首字母必须一致且间隔不大，避免 "ab" 命中一切含 a…b 的长串
  if (!ASCII_TOKEN.test(query) || !ASCII_TOKEN.test(text)) return true
  if (query[0] !== text[0]) return false
  return gapPenalty <= Math.max(1, query.length)
}

function matchScore(query: string, candidate: SearchCandidate): number | null {
  const text = candidate.text
  if (query === text) return candidate.bias
  if (text.startsWith(query)) return PREFIX_MATCH_SCORE + candidate.bias + (text.length - query.length)
  const position = text.indexOf(query)
  if (position >= 0) return CONTAINS_MATCH_SCORE + candidate.bias + position * 2
  if (query.length > 1) {
    const gap = subsequenceGapPenalty(text, query)
    if (gap !== null && allowsFuzzySubsequence(query, text, gap)) {
      return FUZZY_MATCH_SCORE + candidate.bias + gap * 4 + (text.length - query.length)
    }
  }
  return null
}

function scoreCandidates(tokens: string[], candidates: SearchCandidate[]): number | null {
  if (!candidates.length) return null
  let total = 0
  for (const token of tokens) {
    let best: number | null = null
    for (const candidate of candidates) {
      const score = matchScore(token, candidate)
      if (score !== null && (best === null || score < best)) best = score
    }
    if (best === null) return null
    total += best
  }
  return total
}

/// 相关度分数，越低越相关；null 表示不命中，空查询为 0
export function searchScore(query: string, values: unknown[]): number | null {
  const tokens = queryTokens(query)
  if (!tokens.length) return 0
  return scoreCandidates(tokens, collapseCandidates(values))
}

export function searchMatches(query: string, ...values: unknown[]): boolean {
  return searchScore(query, values) !== null
}

/// 过滤并按相关度排序；同分保持原顺序，空查询原样返回
export function filterAndRank<T>(query: string, items: T[], tokens: (item: T) => unknown[]): T[] {
  const parsed = queryTokens(query)
  if (!parsed.length) return items
  return items
    .map((item, index) => ({ item, index, score: scoreCandidates(parsed, collapseCandidates(tokens(item))) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(entry => entry.item)
}

/// 歌曲的常用权重：标题优先，其次歌手，再次专辑
export function trackSearchTokens(track: { title?: string | null; artist?: string | null; album?: string | null }): unknown[] {
  return [searchValue(track.title, 0), searchValue(track.artist, 4), searchValue(track.album, 8)]
}
