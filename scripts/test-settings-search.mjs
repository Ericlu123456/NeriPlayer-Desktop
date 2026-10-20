import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import * as pinyinPro from 'pinyin-pro'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const view = (await read('../src/views/SettingsView.vue')).replace(/\r\n/g, '\n')
// 设置页已按 section 拆成子组件，面板与标题可能位于子组件模板中。
// The settings page is split into section components, so panels and titles may live
// in child component templates.
const sectionSources = [
  { file: 'SettingsView.vue', text: view.slice(view.indexOf('<template>')) },
  ...(await Promise.all(
    ['SettingsAccountsSection', 'SettingsLanguageSection', 'SettingsAboutSection', 'SettingsStorageSection']
      .map(async name => ({
        file: `${name}.vue`,
        text: (await read(`../src/components/settings/${name}.vue`)).replace(/\r\n/g, '\n'),
      })),
  )),
]
const indexSource = await read('../src/modules/settings/searchIndex.ts')
const exports = {}
new Function('exports', ts.transpileModule(indexSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports)
const index = exports.SETTINGS_SEARCH_INDEX

const sectionIds = [...view.matchAll(/^\s+\| '(\w+)'$/gm)].map(match => match[1])
assert.ok(sectionIds.length >= 15, 'SettingsSectionId union is parsed')

const panels = []
for (const source of sectionSources) {
  for (const match of source.text.matchAll(/<div[^>]*class="settings-section-panel"[^>]*data-section="(\w+)"/g)) {
    panels.push({ section: match[1], file: source.file, index: match.index })
  }
}
assert.ok(panels.length > 0, 'every settings panel carries data-section')
for (const panel of panels) {
  assert.ok(sectionIds.includes(panel.section), `panel ${panel.section} in ${panel.file} is a declared section`)
}
for (const id of sectionIds) {
  assert.ok(panels.some(panel => panel.section === id), `section ${id} has a panel`)
}

const indexed = new Set(index.map(entry => `${entry.section}:${entry.title}`))
const missing = []
for (const source of sectionSources) {
  const filePanels = panels.filter(panel => panel.file === source.file).sort((a, b) => a.index - b.index)
  filePanels.forEach((panel, i) => {
    const body = source.text.slice(panel.index, filePanels[i + 1]?.index ?? source.text.length)
    for (const match of body.matchAll(/class="setting-title"[^>]*>\{\{ t\('([\w.]+)'\) \}\}/g)) {
      if (!indexed.has(`${panel.section}:${match[1]}`)) missing.push(`${panel.section}:${match[1]}`)
    }
  })
}
assert.deepEqual(missing, [], 'every static setting title is searchable')
for (const entry of index) assert.ok(sectionIds.includes(entry.section), `index entry ${entry.title} points to a real section`)

const matcher = {}
new Function('require', 'exports', ts.transpileModule(await read('../src/modules/search/textMatcher.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(name => { assert.equal(name, 'pinyin-pro'); return pinyinPro }, matcher)
const parsed = ts.createSourceFile('SettingsView.ts', view.slice(view.indexOf('<script setup lang="ts">') + '<script setup lang="ts">'.length, view.indexOf('</script>')), ts.ScriptTarget.ES2022, true)
const searchStatement = parsed.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'settingsSearchResults'))
const searchCompiled = ts.transpileModule(searchStatement.getText(parsed), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
for (const mac of [false, true]) {
  const results = new Function('computed', 'settingsQuery', 'settingsNavGroups', 'SETTINGS_SEARCH_INDEX', 'SETTINGS_SECTION_IDS', 't', 'filterAndRank', 'searchValue', 'isMacPlatform', `${searchCompiled}\nreturn settingsSearchResults`)(
    callback => callback(), { value: 'macOS' }, { value: [] }, index, sectionIds, key => key,
    matcher.filterAndRank, matcher.searchValue, mac,
  )
  assert.equal(results.some(result => result.key === 'desktop_lyrics:desktop_lyrics.menu_bar'), mac,
    'macOS-only controls must only appear in search on macOS')
}

for (const [query, expected] of [
  ['长音', 'lyrics:settings.lyric_emphasis_threshold'],
  ['long note', 'lyrics:settings.lyric_emphasis_threshold'],
  ['滚动', 'desktop_lyrics:desktop_lyrics.max_width'],
  ['max width', 'desktop_lyrics:desktop_lyrics.max_width'],
]) {
  const results = new Function('computed', 'settingsQuery', 'settingsNavGroups', 'SETTINGS_SEARCH_INDEX', 'SETTINGS_SECTION_IDS', 't', 'filterAndRank', 'searchValue', 'isMacPlatform', `${searchCompiled}\nreturn settingsSearchResults`)(
    callback => callback(), { value: query }, { value: [] }, index, sectionIds, key => key,
    matcher.filterAndRank, matcher.searchValue, false,
  )
  assert.ok(results.some(result => result.key === expected),
    `lyric preferences must be discoverable with ${query}`)
}

console.log(`Settings search index covers ${index.length} entries across ${panels.length} panels`)
