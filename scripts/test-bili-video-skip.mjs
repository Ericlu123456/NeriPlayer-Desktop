import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'

const path = new URL('../src/modules/playback/biliVideoSkip.ts', import.meta.url)
assert.ok(existsSync(path), 'Bilibili skip interval policy is implemented')
const policy = {}
new Function('exports', ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(policy)
const {
  normalizeBiliSkipIntervals, normalizeBiliVideoSkipRules, parseBiliSkipTime, formatBiliSkipTime,
  resolveBiliVideoSkipBvid, resolveBiliVideoSkipCid, resolveBiliVideoSkipTarget,
  intervalsForBiliVideoSkipPlayback, BiliVideoSkipTracker,
} = policy
let cases = 0
function regression(name, run) { run(); cases++; console.log(`ok - ${name}`) }
const interval = (startMs, endMs) => ({ startMs, endMs })
const target = { bvid: 'BVtest', cid: 101 }
const rule = (cid, intervals = [interval(1000, 5000)], extra = {}) => ({ bvid: 'BVtest', cid, intervals, modifiedAt: 100, isDeleted: false, ...extra })

regression('time input follows Android integer seconds and clock forms', () => {
  assert.equal(parseBiliSkipTime(' 12 '), 12000)
  assert.equal(parseBiliSkipTime('02:03'), 123000)
  assert.equal(parseBiliSkipTime('1:02:03'), 3723000)
  assert.equal(parseBiliSkipTime('24:00:00'), 86400000)
  assert.equal(parseBiliSkipTime(' 1 : 02 '), 62000)
  for (const invalid of ['', '1.5', '-1', '1:60', '1:60:00', '24:00:01', '86401', '1::2', 'Infinity']) {
    assert.equal(parseBiliSkipTime(invalid), null, invalid)
  }
})
regression('time formatting preserves Android padding and whole seconds', () => {
  assert.equal(formatBiliSkipTime(-1), '00:00')
  assert.equal(formatBiliSkipTime(62999), '01:02')
  assert.equal(formatBiliSkipTime(3723000), '01:02:03')
})
regression('intervals clamp, sort, merge touching ranges, and reject invalid input', () => {
  assert.deepEqual(normalizeBiliSkipIntervals([
    interval(2000, 4000), interval(-1000, 1000), interval(1000, 2000),
    interval(4000, 9000), interval(6000, 6000), interval(NaN, 10000),
  ], 7000), [interval(0, 7000)])
})
regression('interval limit is applied after sorting and before merging', () => {
  const inputs = Array.from({ length: 101 }, (_, index) => interval(index * 1000, (index + 1) * 1000)).reverse()
  assert.deepEqual(normalizeBiliSkipIntervals(inputs), [interval(0, 100000)])
})
regression('targets preserve CID and BVID for individual pages', () => {
  assert.deepEqual(resolveBiliVideoSkipTarget({ id: 'bilibili:BVtest', album: 'Bilibili|101' }), target)
  assert.deepEqual(resolveBiliVideoSkipTarget({ id: 'bilibili:42', album: 'Bilibili|101|BVtest' }), target)
  assert.deepEqual(resolveBiliVideoSkipTarget({ id: 'local:digest', source: 'local', audioUrl: 'C:/song.flac', syncPayload: { channelId: 'bilibili', subAudioId: '101', album: 'Bilibili|99|BVtest' } }), target)
  assert.equal(resolveBiliVideoSkipTarget({ id: 'netease:42', album: 'Song', syncPayload: { subAudioId: '101' } }), null)
  assert.equal(resolveBiliVideoSkipTarget({ id: 'bilibili:BVtest', album: 'Bilibili' }), null)
  assert.equal(resolveBiliVideoSkipBvid({ id: 'bilibili:BVtest' }), 'BVtest')
  assert.equal(resolveBiliVideoSkipCid({ id: 'bilibili:BVtest', syncPayload: { sub_audio_id: '102' } }), 102)
})
regression('synced source IDs and Android page identities resolve without treating page indexes as CIDs', () => {
  assert.deepEqual(resolveBiliVideoSkipTarget({ id: 'local:digest', syncPayload: { channelId: 'bilibili', audioId: 'BVtest', subAudioId: '101' } }), target)
  assert.equal(resolveBiliVideoSkipBvid({ id: 'bilibili:BVtest:11', album: 'Bilibili' }), 'BVtest')
  assert.equal(resolveBiliVideoSkipCid({ id: 'bilibili:BVtest:11', album: 'Bilibili' }), null)
})
regression('normalization keeps newest rules, live equal-time rules, and merges equal-time intervals', () => {
  assert.deepEqual(normalizeBiliVideoSkipRules([
    rule(101), rule(101, [interval(4000, 7000)]), rule(102, [], { isDeleted: true }),
    rule(103, [interval(2000, 3000)], { modifiedAt: 99 }), rule(103, [], { modifiedAt: 100, isDeleted: true }),
    rule(104, [], { isDeleted: true }), rule(104), rule(0), rule(105, []),
  ]), [rule(101, [interval(1000, 7000)]), rule(102, [], { isDeleted: true }), rule(103, [], { isDeleted: true }), rule(104)])
})
regression('an explicit missing or deleted page never uses another page rule', () => {
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(102)], target, 102, 'BVtest'), [])
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(101, [], { isDeleted: true }), rule(102)], target, 102, 'BVtest'), [])
})
regression('fallback only accepts a unique CID or a unique BVID without a CID', () => {
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(101)], null, 101, 'BVtest'), [interval(1000, 5000)])
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(101), rule(101, [], { bvid: 'BVother', isDeleted: true })], null, 101), [])
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(101)], null, 999, 'BVtest'), [])
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(101)], null, null, 'BVtest'), [interval(1000, 5000)])
  assert.deepEqual(intervalsForBiliVideoSkipPlayback([rule(101), rule(102)], null, null, 'BVtest'), [])
})
regression('tracker uses start-inclusive and end-exclusive intervals', () => {
  const tracker = new BiliVideoSkipTracker()
  assert.equal(tracker.nextSkipPosition([interval(10000, 20000)], 9999, 30000), null)
  assert.equal(tracker.nextSkipPosition([interval(10000, 20000)], 10000, 30000), 20000)
  tracker.reset()
  assert.equal(tracker.nextSkipPosition([interval(10000, 20000)], 20000, 30000), null)
})
regression('tracker chains touching ranges in one jump and skips each only once', () => {
  const tracker = new BiliVideoSkipTracker()
  const intervals = [interval(10000, 15000), interval(15000, 20000), interval(19000, 25000)]
  assert.equal(tracker.nextSkipPosition(intervals, 12000, 30000), 25000)
  assert.equal(tracker.nextSkipPosition(intervals, 21000, 30000), null)
})
regression('rewinding more than one second rearms skipped ranges', () => {
  const tracker = new BiliVideoSkipTracker(), intervals = [interval(10000, 20000)]
  assert.equal(tracker.nextSkipPosition(intervals, 12000, 30000), 20000)
  assert.equal(tracker.nextSkipPosition(intervals, 15000, 30000), null)
  assert.equal(tracker.nextSkipPosition(intervals, 14000, 30000), null)
  assert.equal(tracker.nextSkipPosition(intervals, 12999, 30000), 20000)
})
regression('changing intervals rearms tracker and duration clamps tail skips', () => {
  const tracker = new BiliVideoSkipTracker()
  assert.equal(tracker.nextSkipPosition([], 12000, 30000), null)
  assert.equal(tracker.nextSkipPosition([interval(10000, 40000)], 12000, 30000), 30000)
  assert.equal(tracker.nextSkipPosition([interval(10000, 25000)], 12000, 30000), 25000)
})
console.log(`Bilibili skip interval policy: ${cases} passed`)
