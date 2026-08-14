/**
 * schedule.test.js — invariants the design rests on. Run with `npm test`.
 *
 * These are combinatorial claims, not behaviour that can be eyeballed: that the
 * rotation really does cover all 66 pairs exactly once, that every setup really
 * does get the same number of comparisons, that the position counterbalance is
 * exactly 50/50 rather than approximately so. If any of them silently stopped
 * holding, the schedule would still run and still produce a ranking — just a
 * biased one. Hence tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSchedule,
  connectivity,
  defaultAblationGroups,
  jobKey,
  layerOfPair,
  oneFactorization,
  outstandingJobs,
  parseSetupId,
  positionAssignments,
  scheduleReport,
} from './schedule.js'

const PIPELINES = ['baseline', 'no-iteration', 'full-pipeline']
const MODELS = ['gemini', 'gpt', 'kimi', 'qwen']
const SETUPS = PIPELINES.flatMap(p => MODELS.map(m => `${p}-${m}_FINAL`))

// Shaped like the real dataset: 4 subjects × 25 figures, split unevenly between
// 2d and 3d, so most strata hold an odd number and the exactly-half case is not
// the only one under test.
const SPLITS = { physics: 10, chemistry: 12, cs: 13, math: 12 }
const FIGURES = Object.entries(SPLITS).flatMap(([subject, twoD]) =>
  Array.from({ length: 25 }, (_, i) => ({
    stem: `${subject}-${String(i).padStart(2, '0')}`,
    subject,
    type: i < twoD ? '2d' : '3d',
  }))
)

const unorderedPair = (a, b) => [a, b].sort().join('|')

// ── The rotation ──────────────────────────────────────────────────────────────

test('oneFactorization(12) is 11 rounds of 6 disjoint matches', () => {
  const rounds = oneFactorization(12)
  assert.equal(rounds.length, 11)
  for (const round of rounds) {
    assert.equal(round.length, 6)
    const seen = new Set(round.flat())
    assert.equal(seen.size, 12, 'each round must be a perfect matching')
  }
})

test('oneFactorization(12) covers all 66 pairs exactly once', () => {
  const counts = new Map()
  for (const round of oneFactorization(12)) {
    for (const [a, b] of round) {
      const k = unorderedPair(a, b)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  assert.equal(counts.size, 66)
  assert.ok([...counts.values()].every(c => c === 1), 'no pair may repeat within a cycle')
})

test('oneFactorization handles an odd number of setups with a bye', () => {
  const rounds = oneFactorization(13)
  assert.equal(rounds.length, 13)
  const counts = new Map()
  for (const round of rounds) {
    assert.equal(round.length, 6, 'one vertex sits out each round')
    for (const [a, b] of round) {
      const k = unorderedPair(a, b)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  assert.equal(counts.size, (13 * 12) / 2)
  assert.ok([...counts.values()].every(c => c === 1))
})

// ── Setup identity ────────────────────────────────────────────────────────────

test('parseSetupId splits pipeline from model, including hyphenated pipelines', () => {
  assert.deepEqual(parseSetupId('full-pipeline-gemini_FINAL'), { pipeline: 'full-pipeline', model: 'gemini' })
  assert.deepEqual(parseSetupId('no-iteration-kimi_FINAL'), { pipeline: 'no-iteration', model: 'kimi' })
  assert.deepEqual(parseSetupId('baseline-gpt_FINAL'), { pipeline: 'baseline', model: 'gpt' })
  assert.equal(parseSetupId('unparseable'), null)
})

test('ablation groups hold the model fixed', () => {
  const groups = defaultAblationGroups(SETUPS)
  assert.equal(groups.length, 4)
  for (const g of groups) {
    assert.equal(g.length, 3)
    const models = new Set(g.map(id => parseSetupId(id).model))
    assert.equal(models.size, 1, 'a group varies pipeline only')
  }
})

// ── The schedule ──────────────────────────────────────────────────────────────

test('the schedule is far smaller than a round robin but covers every pair', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  const roundRobin = ((12 * 11) / 2) * 100
  assert.ok(schedule.length < roundRobin / 2, `expected well under ${roundRobin / 2}, got ${schedule.length}`)

  const pairs = new Set(schedule.map(j => j.pair))
  assert.equal(pairs.size, 66, 'every pair must appear somewhere, or BT has to infer it blind')
})

test('layer A runs all 12 within-model pairs on all 100 figures', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  const ablation = schedule.filter(j => j.layer === 'ablation')
  assert.equal(ablation.length, 12 * 100)

  const byPair = new Map()
  for (const j of ablation) byPair.set(j.pair, (byPair.get(j.pair) ?? 0) + 1)
  assert.equal(byPair.size, 12)
  assert.ok([...byPair.values()].every(c => c === 100))

  for (const j of ablation) {
    assert.equal(parseSetupId(j.setupA).model, parseSetupId(j.setupB).model)
  }
})

test('every setup gets within a comparison or two of the same workload', () => {
  // Not exact: a rotation fixture layer A already covers is dropped rather than run
  // twice, and which setups lose one that way depends on the rounds they draw. The
  // residue is bounded and tiny; anything larger would be a real design fault.
  for (const passes of [1, 2, 3, 4]) {
    const schedule = buildSchedule(SETUPS, FIGURES, { passes })
    const counts = Object.fromEntries(SETUPS.map(s => [s, 0]))
    for (const j of schedule) {
      counts[j.setupA]++
      counts[j.setupB]++
    }
    const values = Object.values(counts)
    const spread = Math.max(...values) - Math.min(...values)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    assert.ok(spread <= 2, `passes=${passes}: spread ${spread} across ${JSON.stringify(counts)}`)
    assert.ok(spread / mean < 0.01, `passes=${passes}: spread is ${(100 * spread / mean).toFixed(1)}% of the mean`)
  }
})

test('no comparison is scheduled twice', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  assert.equal(new Set(schedule.map(jobKey)).size, schedule.length)
})

test('the schedule is deterministic across builds', () => {
  const a = buildSchedule(SETUPS, FIGURES)
  const b = buildSchedule([...SETUPS].reverse(), [...FIGURES].reverse())
  assert.deepEqual(a.map(jobKey), b.map(jobKey), 'input order must not change the plan')
})

test('a different seed deals different rotation fixtures', () => {
  const a = buildSchedule(SETUPS, FIGURES, { seed: 'one' })
  const b = buildSchedule(SETUPS, FIGURES, { seed: 'two' })
  assert.notDeepEqual(a.map(jobKey), b.map(jobKey))
})

test('every setup is judged on every figure, and more passes means more of it', () => {
  let previous = 0
  for (const passes of [1, 2, 3, 4]) {
    const schedule = buildSchedule(SETUPS, FIGURES, { passes })
    const perSetupPerFigure = new Map()
    for (const j of schedule) {
      for (const s of [j.setupA, j.setupB]) {
        const k = `${s}|${j.stem}`
        perSetupPerFigure.set(k, (perSetupPerFigure.get(k) ?? 0) + 1)
      }
    }
    // Nothing generated goes unjudged: all 12 setups appear on all 100 figures.
    assert.equal(perSetupPerFigure.size, SETUPS.length * FIGURES.length)
    const counts = [...perSetupPerFigure.values()]
    // Floor is layer A alone: on a figure where this setup's rotation fixture
    // happens to be a within-model pair, layer A has already run it and the
    // rotation adds nothing. Ceiling is its two pairs plus one fixture per pass.
    assert.ok(Math.min(...counts) >= 2, 'every setup is judged at least twice on every figure')
    assert.ok(Math.max(...counts) <= 2 + passes, 'no setup can exceed its two pairs plus one per pass')

    assert.ok(schedule.length > previous, 'an extra pass must add work')
    previous = schedule.length
  }
})

test('passes are cumulative, so more can be bought without redoing anything', () => {
  // The property that lets a run be paid for a pass at a time: everything planned
  // at k passes is still planned at k+1, so results already collected stay in the
  // design rather than being stranded outside it.
  for (let k = 1; k < 5; k++) {
    const fewer = new Set(buildSchedule(SETUPS, FIGURES, { passes: k }).map(jobKey))
    const more = new Set(buildSchedule(SETUPS, FIGURES, { passes: k + 1 }).map(jobKey))
    for (const key of fewer) {
      assert.ok(more.has(key), `passes=${k + 1} dropped a comparison that passes=${k} planned`)
    }
    assert.ok(more.size > fewer.size, 'an extra pass must add work')
  }
})

test('the rotation saturates into a full round robin', () => {
  const schedule = buildSchedule(SETUPS, FIGURES, { passes: 11 })
  assert.equal(schedule.length, ((12 * 11) / 2) * FIGURES.length)
})

test('setups that do not follow the naming convention still get covered', () => {
  const odd = [...SETUPS, 'mystery']
  const schedule = buildSchedule(odd, FIGURES)
  const involved = schedule.filter(j => j.setupA === 'mystery' || j.setupB === 'mystery')
  assert.ok(involved.length > 0, 'layer B needs no naming convention')
  assert.ok(involved.every(j => j.layer === 'rotation'))
})

// ── Resuming ──────────────────────────────────────────────────────────────────

test('outstanding work is exactly what has no result yet', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  const done = new Set(schedule.slice(0, 900).map(jobKey))
  const left = outstandingJobs(schedule, done)
  assert.equal(left.length, schedule.length - 900)
  assert.ok(left.every(j => !done.has(jobKey(j))))
})

test('an interrupted run resumes without redoing or dropping work', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  // A run that died partway, with scattered failures inside the completed stretch.
  const done = new Set(schedule.slice(0, 500).filter((_, i) => i % 7 !== 0).map(jobKey))
  const resumed = buildSchedule(SETUPS, FIGURES) // rebuilt from scratch, as the CLI does
  const left = outstandingJobs(resumed, done)

  assert.equal(left.length + done.size, schedule.length)
  const union = new Set([...done, ...left.map(jobKey)])
  assert.equal(union.size, schedule.length, 'resume must cover the plan exactly once')
})

// ── Integrity reporting ───────────────────────────────────────────────────────

test('connectivity spots a split comparison graph', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.equal(connectivity(ids, [['a', 'b'], ['b', 'c'], ['c', 'd']]).connected, true)

  const split = connectivity(ids, [['a', 'b'], ['c', 'd']])
  assert.equal(split.connected, false)
  assert.equal(split.components.length, 2)
})

test('a report on a fresh plan warns that nothing is done but not that it is broken', () => {
  const report = scheduleReport(buildSchedule(SETUPS, FIGURES), new Set())
  assert.equal(report.done, 0)
  assert.equal(report.remaining, report.total)
  assert.equal(report.pairs.planned, 66)
  assert.ok(report.warnings.some(w => w.includes('no completed comparison')))
})

test('a completed plan reports clean, connected and balanced', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  const report = scheduleReport(schedule, new Set(schedule.map(jobKey)))
  assert.equal(report.remaining, 0)
  assert.equal(report.connected, true)
  assert.ok(report.balance.max - report.balance.min <= 2, 'balanced to within the dedupe residue')
  assert.deepEqual(report.warnings, [])
})

test('losing an entire setup to failures is reported, not swallowed', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  const dead = SETUPS[0]
  const done = new Set(schedule.filter(j => j.setupA !== dead && j.setupB !== dead).map(jobKey))
  const report = scheduleReport(schedule, done)

  assert.equal(report.connected, false, 'the dead setup is isolated')
  assert.ok(report.warnings.some(w => w.includes('disconnected')))
  assert.ok(report.warnings.some(w => w.includes(dead)))
})

// ── Position counterbalancing ─────────────────────────────────────────────────

test('positions are balanced within every stratum, exactly where the size allows', () => {
  const [a, b] = [SETUPS[0], SETUPS[1]]
  const first = [a, b].sort()[0]
  const assigned = positionAssignments(a, b, FIGURES)
  assert.equal(assigned.size, FIGURES.length)

  const tally = new Map()
  for (const f of FIGURES) {
    const key = `${f.subject}__${f.type}`
    if (!tally.has(key)) tally.set(key, { total: 0, aFirst: 0 })
    const t = tally.get(key)
    t.total++
    if (assigned.get(f.stem).figure1 === first) t.aFirst++
  }

  for (const [key, t] of tally) {
    // An odd stratum cannot split evenly; one unpaired figure is the whole slack.
    assert.ok(Math.abs(t.aFirst * 2 - t.total) <= 1, `${key}: ${t.aFirst}/${t.total} is off by more than one`)
    if (t.total % 2 === 0) assert.equal(t.aFirst * 2, t.total, `${key} is even and must split exactly`)
  }
})

test('the overall split is exactly even, for every pair', () => {
  // The odd strata cannot each split evenly, but their leftovers are dealt to
  // alternate sides, so they cancel and the total is exact. This is the property
  // a coin flip does not have and the reason for the change.
  for (let i = 0; i < SETUPS.length; i++) {
    for (let j = i + 1; j < SETUPS.length; j++) {
      const first = [SETUPS[i], SETUPS[j]].sort()[0]
      const assigned = positionAssignments(SETUPS[i], SETUPS[j], FIGURES)
      const aFirst = FIGURES.filter(f => assigned.get(f.stem).figure1 === first).length
      assert.equal(aFirst * 2, FIGURES.length, `${first} led ${aFirst}/${FIGURES.length}`)
    }
  }
})

test('positions are stable across calls, so a retry reproduces the seating', () => {
  const first = positionAssignments(SETUPS[0], SETUPS[1], FIGURES)
  const second = positionAssignments(SETUPS[1], SETUPS[0], [...FIGURES].reverse())
  for (const f of FIGURES) {
    assert.deepEqual(second.get(f.stem), first.get(f.stem), 'argument order must not matter')
  }
})

test('a figure does not seat the same setup first in every pair it appears in', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  const byPair = new Map()
  for (const j of schedule) {
    if (!byPair.has(j.pair)) byPair.set(j.pair, { a: j.setupA, b: j.setupB, figs: [] })
    byPair.get(j.pair).figs.push(FIGURES.find(f => f.stem === j.stem))
  }

  // For one figure, collect which side led across all its pairs. If the phase
  // offset were missing, the canonically-first setup would always lead.
  const target = FIGURES[3].stem
  const leaders = []
  for (const [, { a, b, figs }] of byPair) {
    if (!figs.some(f => f.stem === target)) continue
    const seat = positionAssignments(a, b, figs).get(target)
    leaders.push(seat.figure1 === [a, b].sort()[0])
  }
  assert.ok(leaders.length > 1)
  assert.equal(new Set(leaders).size, 2, 'position must not be a constant function of the figure')
})

// ── Recovering the layer from a finished comparison ───────────────────────────

test('layerOfPair reproduces the schedule\'s own label for every planned job', () => {
  const schedule = buildSchedule(SETUPS, FIGURES)
  assert.ok(schedule.length > 0)
  for (const job of schedule) {
    assert.equal(
      layerOfPair(job.setupA, job.setupB), job.layer,
      `${job.pair} was planned as ${job.layer} but classifies as ${layerOfPair(job.setupA, job.setupB)}`,
    )
  }
})

test('both layers are actually present, so the check above is not vacuous', () => {
  const layers = new Set(buildSchedule(SETUPS, FIGURES).map(j => layerOfPair(j.setupA, j.setupB)))
  assert.deepEqual([...layers].sort(), ['ablation', 'rotation'])
})

test('same model on both sides is an ablation, whatever the pipelines', () => {
  assert.equal(layerOfPair('baseline-gemini_FINAL', 'full-pipeline-gemini_FINAL'), 'ablation')
  assert.equal(layerOfPair('no-iteration-qwen_FINAL', 'baseline-qwen_FINAL'), 'ablation')
})

test('different models is a rotation, even for the same pipeline', () => {
  assert.equal(layerOfPair('baseline-gemini_FINAL', 'baseline-gpt_FINAL'), 'rotation')
  assert.equal(layerOfPair('full-pipeline-kimi_FINAL', 'baseline-qwen_FINAL'), 'rotation')
})

test('argument order does not change the layer', () => {
  for (const [a, b] of [['baseline-gpt_FINAL', 'full-pipeline-gpt_FINAL'], ['baseline-gpt_FINAL', 'baseline-kimi_FINAL']]) {
    assert.equal(layerOfPair(a, b), layerOfPair(b, a))
  }
})

/** An id the convention cannot parse is dropped from layer A, so it is layer B. */
test('an unparseable setup id falls to rotation rather than throwing', () => {
  assert.equal(layerOfPair('weird', 'baseline-gpt_FINAL'), 'rotation')
  assert.equal(layerOfPair('weird', 'alsoweird'), 'rotation')
})
