/**
 * rankings.test.js — the layer filter, the per-model split, and the source.
 *
 * The scoring itself is ported verbatim from visionbook and is not re-derived
 * here. What is new, and what these cover, is that a ranking is only ever fitted
 * over evidence that supports it: the ablation layer is four disconnected graphs
 * and must be reported as four tables, and a ranking is built from exactly one
 * judge's verdicts — human included — rather than from a mixture.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRankings, LAYERS, DIMENSIONS } from './rankings.js'

/** A machine record with a decided winner. */
const rec = (setupA, setupB, winner) => ({
  setupA, setupB,
  machineEval: { aggregator: { winner }, dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, { winner }])) },
  humanEvals: [],
})

/** Two models x three pipelines: within-model pairs are layer A, the rest layer B. */
const models = ['gemini', 'gpt']
const pipelines = ['baseline', 'full-pipeline', 'no-iteration']
const setup = (p, m) => `${p}-${m}_FINAL`

const ABLATION = models.flatMap(m => [
  rec(setup('baseline', m), setup('full-pipeline', m), setup('full-pipeline', m)),
  rec(setup('baseline', m), setup('no-iteration', m), setup('baseline', m)),
  rec(setup('full-pipeline', m), setup('no-iteration', m), setup('full-pipeline', m)),
])
const ROTATION = [
  rec(setup('baseline', 'gemini'), setup('baseline', 'gpt'), setup('baseline', 'gpt')),
  rec(setup('full-pipeline', 'gemini'), setup('full-pipeline', 'gpt'), setup('full-pipeline', 'gpt')),
]
const ALL = [...ABLATION, ...ROTATION]

const totalComparisons = g => g.ranking.overall.reduce((n, r) => n + r.comparisons, 0)
const sumComparisons = res => res.groups.reduce((n, g) => n + totalComparisons(g), 0)

// ── Layers ────────────────────────────────────────────────────────────────────

test('LAYERS names exactly the three modes the table offers', () => {
  assert.deepEqual(LAYERS, ['all', 'ablation', 'rotation'])
})

test('all and rotation are a single table', () => {
  assert.equal(buildRankings(ALL).groups.length, 1)
  assert.equal(buildRankings(ALL, null, { layer: 'rotation' }).groups.length, 1)
})

test('a single-group result carries no label, so it renders without a heading', () => {
  assert.equal(buildRankings(ALL).groups[0].label, null)
  assert.equal(buildRankings(ALL).groups[0].key, 'all')
})

test('the two layers still partition the records', () => {
  const a = sumComparisons(buildRankings(ALL, null, { layer: 'ablation' }))
  const b = sumComparisons(buildRankings(ALL, null, { layer: 'rotation' }))
  assert.equal(a + b, sumComparisons(buildRankings(ALL, null, { layer: 'all' })))
})

// ── The per-model ablation split ──────────────────────────────────────────────

test('ablation yields one table per experiment model, in a stable order', () => {
  const { groups } = buildRankings(ALL, null, { layer: 'ablation' })
  assert.deepEqual(groups.map(g => g.key), ['gemini', 'gpt'])
  assert.deepEqual(groups.map(g => g.label), ['gemini', 'gpt'])
})

test('each ablation table holds only its own model’s setups', () => {
  for (const g of buildRankings(ALL, null, { layer: 'ablation' }).groups) {
    assert.equal(g.setups.length, 3, `${g.key} should rank three pipelines`)
    for (const s of g.setups) assert.ok(s.endsWith(`-${g.key}_FINAL`), `${s} is not a ${g.key} setup`)
    for (const row of g.ranking.overall) assert.ok(row.id.endsWith(`-${g.key}_FINAL`))
  }
})

/**
 * The bug this split exists to fix: one combined fit puts setups on a shared
 * scale that no comparison ever established. Each table standing alone means
 * each table's scores sum to 1.
 */
test('each ablation table is its own normalised scale', () => {
  for (const g of buildRankings(ALL, null, { layer: 'ablation' }).groups) {
    const total = g.ranking.overall.reduce((n, r) => n + r.score, 0)
    assert.ok(Math.abs(total - 1) < 1e-6, `${g.key} scores sum to ${total}, not 1`)
  }
})

test('no ablation table mixes two models', () => {
  for (const g of buildRankings(ALL, null, { layer: 'ablation' }).groups) {
    const seen = new Set(g.setups.map(s => s.match(/-([^-]+)_FINAL$/)[1]))
    assert.equal(seen.size, 1, `${g.key} spans ${[...seen].join(', ')}`)
  }
})

test('each ablation table is internally connected on full data', () => {
  for (const g of buildRankings(ALL, null, { layer: 'ablation' }).groups) {
    assert.equal(g.connected, true, `${g.key} is not connected`)
  }
})

/** A model with only one of its three pairs evaluated cannot be ranked honestly. */
test('a table reports connected: false when its own data is too sparse', () => {
  const partial = [rec(setup('baseline', 'gemini'), setup('full-pipeline', 'gemini'), setup('baseline', 'gemini'))]
  const isolated = [...partial, rec(setup('no-iteration', 'gpt'), setup('baseline', 'gpt'), setup('baseline', 'gpt'))]
  // Two models, each a single edge: connected within itself.
  for (const g of buildRankings(isolated, null, { layer: 'ablation' }).groups) {
    assert.equal(g.connected, true)
  }
  // One model whose three setups form two disjoint pieces cannot happen with a
  // single pair, so build it explicitly: a lone pair plus an unlinked third.
  const split = [
    rec('baseline-kimi_FINAL', 'full-pipeline-kimi_FINAL', 'baseline-kimi_FINAL'),
    rec('no-iteration-kimi_FINAL', 'extra-kimi_FINAL', 'extra-kimi_FINAL'),
  ]
  const g = buildRankings(split, null, { layer: 'ablation' }).groups[0]
  assert.equal(g.connected, false, 'two disjoint pairs in one model must be flagged')
})

test('ablation over rotation-only records yields no tables at all', () => {
  assert.deepEqual(buildRankings(ROTATION, null, { layer: 'ablation' }).groups, [])
})

// ── Source: a machine judge, or the humans ────────────────────────────────────

test('the machine source ranks aggregator winners and carries every dimension', () => {
  const g = buildRankings(ALL, null, { source: 'machine' }).groups[0]
  assert.ok(g.ranking.overall.length > 0)
  for (const d of DIMENSIONS) assert.ok(g.ranking[d], `missing dimension ${d}`)
})

test('the human source ranks human winners and has an overall only', () => {
  const judged = ALL.map(r => ({ ...r, humanEvals: [{ winner: r.machineEval.aggregator.winner }] }))
  const g = buildRankings(judged, null, { source: 'human' }).groups[0]
  assert.equal(totalComparisons(g), sumComparisons(buildRankings(judged)))
  for (const d of DIMENSIONS) assert.equal(g.ranking[d], undefined, `human must not report ${d}`)
})

/** The point of one source per ranking: a judge's verdicts never leak into another's. */
test('the human source ignores machine verdicts entirely', () => {
  const g = buildRankings(ALL, null, { source: 'human' }).groups[0]
  assert.deepEqual(g.ranking.overall, [], 'no human verdicts means no human ranking')
})

test('the machine source ignores human verdicts entirely', () => {
  const humanOnly = ALL.map(r => ({ setupA: r.setupA, setupB: r.setupB, humanEvals: [{ winner: r.setupA }] }))
  assert.deepEqual(buildRankings(humanOnly, null, { source: 'machine' }).groups[0].ranking.overall, [])
})

test('the per-model split applies to the human source too', () => {
  const judged = ABLATION.map(r => ({ ...r, humanEvals: [{ winner: r.machineEval.aggregator.winner }] }))
  const { groups } = buildRankings(judged, null, { layer: 'ablation', source: 'human' })
  assert.deepEqual(groups.map(g => g.key), ['gemini', 'gpt'])
})

// ── Filtering ─────────────────────────────────────────────────────────────────

test('the setup picker keeps every setup regardless of layer or source', () => {
  const all = buildRankings(ALL).availableSetups
  assert.equal(all.length, 6)
  for (const layer of LAYERS) {
    assert.deepEqual(buildRankings(ALL, null, { layer }).availableSetups, all)
  }
  assert.deepEqual(buildRankings(ALL, null, { source: 'human' }).availableSetups, all)
})

test('the layer filter composes with the setup selection', () => {
  const gemini = pipelines.map(p => setup(p, 'gemini'))
  const { groups } = buildRankings(ALL, gemini, { layer: 'ablation' })
  assert.deepEqual(groups.map(g => g.key), ['gemini'])
  assert.equal(totalComparisons(groups[0]), 6)
  // Both selected setups are the same model, so nothing survives the rotation filter.
  assert.deepEqual(buildRankings(ALL, gemini, { layer: 'rotation' }).groups[0].ranking.overall, [])
})

test('the dimension rankings are filtered by layer too, not just the overall one', () => {
  const { groups } = buildRankings(ALL, null, { layer: 'ablation' })
  for (const g of groups) {
    assert.equal(g.ranking.geometry.reduce((n, x) => n + x.comparisons, 0), totalComparisons(g))
  }
})
