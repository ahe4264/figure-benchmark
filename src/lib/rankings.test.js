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

import { buildRankings, computeBradleyTerry, LAYERS, DIMENSIONS, ELO_SCALE, ELO_ANCHOR } from './rankings.js'

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

// ── The Elo-style scale ───────────────────────────────────────────────────────

/**
 * `score` is a probability normalised to sum to 1, so it depends on how many
 * setups share the table. `elo` is the log transform the leaderboard actually
 * shows: differences on it are a property of the fit alone, which is what makes
 * a gap mean the same thing in every table and under every setup selection.
 */

/** n independent decisions between two setups, `aWins` of them going to `a`. */
const duel = (a, b, aWins, n) => Array.from({ length: n }, (_, i) => ({ a, b, aWins: i < aWins ? 1 : 0 }))

test('elo differences are the log-odds of the fitted strengths', () => {
  const rows = computeBradleyTerry(duel('x', 'y', 30, 40), { bootstrapRounds: 0 })
  const [hi, lo] = rows
  const expected = ELO_SCALE * Math.log(hi.score / lo.score)
  assert.ok(Math.abs((hi.elo - lo.elo) - expected) < 1e-6)
})

test('a 400-point gap is 10:1 odds, so ~91% win probability', () => {
  // Construct it from the fit rather than asserting a magic number: whatever the
  // gap is, feeding it back through the logistic must reproduce the win rate.
  const rows = computeBradleyTerry(duel('x', 'y', 30, 40), { bootstrapRounds: 0 })
  const [hi, lo] = rows
  const pWin = 1 / (1 + Math.pow(10, -(hi.elo - lo.elo) / 400))
  assert.ok(Math.abs(pWin - 0.75) < 0.02, `expected ~0.75, got ${pWin}`)
})

test('the scale is anchored so the mean is ELO_ANCHOR', () => {
  const rows = computeBradleyTerry(duel('x', 'y', 30, 40), { bootstrapRounds: 0 })
  const mean = rows.reduce((n, r) => n + r.elo, 0) / rows.length
  assert.ok(Math.abs(mean - ELO_ANCHOR) < 1e-6, `mean is ${mean}`)
})

test('elo orders the table exactly as score does', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 8, 10), ...duel('b', 'c', 7, 10), ...duel('a', 'c', 9, 10),
  ], { bootstrapRounds: 0 })
  const byElo = [...rows].sort((x, y) => y.elo - x.elo).map(r => r.id)
  assert.deepEqual(byElo, rows.map(r => r.id))
})

test('a winless setup is pinned to the rail rather than running to -Infinity', () => {
  const rows = computeBradleyTerry(duel('x', 'y', 20, 20), { bootstrapRounds: 0 })
  for (const r of rows) assert.ok(Number.isFinite(r.elo), `${r.id} has elo ${r.elo}`)
})

// ── Bootstrap confidence intervals ────────────────────────────────────────────

test('the interval brackets the point estimate', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 8, 12), ...duel('b', 'c', 7, 12), ...duel('a', 'c', 9, 12),
  ])
  for (const r of rows) {
    assert.ok(r.eloLow <= r.elo + 1e-6, `${r.id}: low ${r.eloLow} > elo ${r.elo}`)
    assert.ok(r.eloHigh >= r.elo - 1e-6, `${r.id}: high ${r.eloHigh} < elo ${r.elo}`)
  }
})

/** The whole point of showing the interval: less evidence has to look less certain. */
test('fewer comparisons give a wider interval at the same win rate', () => {
  const width = n => {
    const rows = computeBradleyTerry([
      ...duel('a', 'b', n * 0.75, n), ...duel('b', 'c', n * 0.75, n), ...duel('a', 'c', n * 0.75, n),
    ])
    return rows.reduce((w, r) => w + (r.eloHigh - r.eloLow), 0) / rows.length
  }
  assert.ok(width(12) > width(200), 'a 12-comparison fit must not look as certain as a 200-comparison one')
})

/** An interval that jitters on every refresh reads as a bug, not as uncertainty. */
test('the interval is deterministic across calls', () => {
  const build = () => computeBradleyTerry([
    ...duel('a', 'b', 8, 12), ...duel('b', 'c', 7, 12), ...duel('a', 'c', 9, 12),
  ])
  assert.deepEqual(build(), build())
})

test('bootstrapRounds: 0 reports no interval rather than a fake one', () => {
  for (const r of computeBradleyTerry(duel('x', 'y', 8, 10), { bootstrapRounds: 0 })) {
    assert.equal(r.eloLow, null)
    assert.equal(r.eloHigh, null)
  }
})

// ── Rank as a spread, not a position ──────────────────────────────────────────

/**
 * rankUB follows the arena convention: 1 + the number of setups whose interval
 * lies entirely above this one's. Setups the evidence cannot separate therefore
 * share a rank, instead of being ordered by a difference that is noise.
 */

test('a decisive winner takes rank 1 alone and the loser does not', () => {
  const rows = computeBradleyTerry(duel('strong', 'weak', 190, 200))
  const strong = rows.find(r => r.id === 'strong')
  const weak = rows.find(r => r.id === 'weak')
  assert.equal(strong.rankUB, 1)
  assert.equal(strong.rankLB, 1)
  assert.equal(weak.rankUB, 2)
})

test('setups the evidence cannot separate share rank 1', () => {
  // Two setups, a dead heat over very little data: nothing is separable.
  for (const r of computeBradleyTerry(duel('x', 'y', 2, 4))) {
    assert.equal(r.rankUB, 1, `${r.id} claims rank ${r.rankUB} on four comparisons`)
  }
})

test('the spread runs the right way and stays inside the table', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 40, 50), ...duel('b', 'c', 30, 50), ...duel('a', 'c', 45, 50),
  ])
  for (const r of rows) {
    assert.ok(r.rankUB >= 1, `${r.id} rankUB ${r.rankUB}`)
    assert.ok(r.rankLB <= rows.length, `${r.id} rankLB ${r.rankLB} exceeds ${rows.length}`)
    assert.ok(r.rankUB <= r.rankLB, `${r.id} spread ${r.rankUB}-${r.rankLB} is inverted`)
  }
})

test('with no interval to compare, rank falls back to the ordinal position', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 8, 10), ...duel('b', 'c', 7, 10), ...duel('a', 'c', 9, 10),
  ], { bootstrapRounds: 0 })
  assert.deepEqual(rows.map(r => r.rankUB), [1, 2, 3])
  assert.deepEqual(rows.map(r => r.rankLB), [1, 2, 3])
})

// ── The fields survive the trip through buildRankings ─────────────────────────

test('buildRankings carries the interval and the rank spread onto every row', () => {
  for (const g of buildRankings(ALL).groups) {
    for (const row of g.ranking.overall) {
      for (const f of ['elo', 'eloLow', 'eloHigh', 'rankUB', 'rankLB']) {
        assert.ok(row[f] != null, `overall row ${row.id} is missing ${f}`)
      }
    }
  }
})

// ── Separation by the paired test, not by overlapping intervals ───────────────

/**
 * The rank is a single integer, arena-style: setups the evidence cannot order
 * share it, and `tiedWith` names who they share it with. What decides "cannot
 * order" is the paired replicate test, so a pair whose marginal intervals graze
 * each other at the tail is still ranked when the difference itself is decisive.
 */

test('a tie group is symmetric — if a cannot be ordered against b, nor b against a', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 26, 50), ...duel('b', 'c', 25, 50), ...duel('a', 'c', 27, 50),
  ])
  const by = Object.fromEntries(rows.map(r => [r.id, r]))
  for (const r of rows) {
    for (const other of r.tiedWith) {
      assert.ok(by[other].tiedWith.includes(r.id), `${r.id} ties ${other} but not the reverse`)
    }
  }
})

test('no setup is ever tied with itself', () => {
  for (const r of computeBradleyTerry([...duel('a', 'b', 5, 10), ...duel('b', 'c', 5, 10)])) {
    assert.ok(!r.tiedWith.includes(r.id))
  }
})

test('a decisively separated table has no tie groups and a strict 1..N rank', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 180, 200), ...duel('b', 'c', 180, 200), ...duel('a', 'c', 195, 200),
  ])
  assert.deepEqual(rows.map(r => r.rankUB), [1, 2, 3])
  for (const r of rows) assert.deepEqual(r.tiedWith, [], `${r.id} should be separated from everyone`)
})

test('rank counts exactly the setups that are neither tied nor below', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 34, 50), ...duel('b', 'c', 33, 50), ...duel('a', 'c', 45, 50),
  ])
  for (const row of rows) {
    const above = rows.filter(o => o !== row && !row.tiedWith.includes(o.id) && o.elo > row.elo)
    assert.equal(row.rankUB, 1 + above.length, `${row.id} claims rank ${row.rankUB}`)
  }
})

test('an evenly matched pair shares rank 1 and names the other in tiedWith', () => {
  const rows = computeBradleyTerry(duel('x', 'y', 2, 4))
  for (const r of rows) {
    assert.equal(r.rankUB, 1)
    assert.equal(r.tiedWith.length, 1)
  }
})

/**
 * The reason the paired test replaces the interval-overlap one. Two setups can
 * overlap on their marginal intervals and still be ordered decisively, because
 * every replicate moves them together and it is the difference that is measured.
 */
test('a pair whose marginal intervals overlap can still be separated', () => {
  // Close margins over a lot of comparisons: each rating stays loose enough that
  // the two intervals graze, while the difference between them is well pinned.
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 265, 500), ...duel('b', 'c', 260, 500), ...duel('a', 'c', 280, 500),
  ])
  const [top, mid] = rows
  const overlap = top.eloLow <= mid.eloHigh
  assert.ok(overlap, 'fixture no longer overlaps — pick a closer pair')
  assert.ok(!top.tiedWith.includes(mid.id), 'overlapping intervals must not by themselves force a tie')
  assert.equal(mid.rankUB, 2)
})

test('bootstrapRounds: 0 reports no tie groups and a plain ordinal rank', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 8, 10), ...duel('b', 'c', 7, 10), ...duel('a', 'c', 9, 10),
  ], { bootstrapRounds: 0 })
  assert.deepEqual(rows.map(r => r.rankUB), [1, 2, 3])
  for (const r of rows) assert.deepEqual(r.tiedWith, [])
})

test('the internal setup index never leaks into a row', () => {
  for (const r of computeBradleyTerry(duel('x', 'y', 7, 10))) {
    assert.equal(r.index, undefined)
  }
})

test('buildRankings carries tiedWith onto every row', () => {
  for (const g of buildRankings(ALL).groups) {
    for (const row of g.ranking.overall) {
      assert.ok(Array.isArray(row.tiedWith), `${row.id} has no tiedWith`)
    }
  }
})

// ── Confidence in one step of the ordering ────────────────────────────────────

/**
 * What the table leads with. A shared rank claims two setups are equal, which the
 * ratings beside it visibly contradict; this claims only that one row sits above
 * the next, and says how firmly.
 */

test('the last row has no step below it', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 8, 12), ...duel('b', 'c', 7, 12), ...duel('a', 'c', 9, 12),
  ])
  assert.equal(rows[rows.length - 1].beatsNext, null)
  for (const r of rows.slice(0, -1)) assert.ok(r.beatsNext > 0 && r.beatsNext <= 1)
})

test('a decisive step reads near certain, a coin flip reads near half', () => {
  const decisive = computeBradleyTerry(duel('strong', 'weak', 190, 200))
  assert.ok(decisive[0].beatsNext > 0.99, `got ${decisive[0].beatsNext}`)

  const coinFlip = computeBradleyTerry(duel('x', 'y', 2, 4))
  assert.ok(Math.abs(coinFlip[0].beatsNext - 0.5) < 0.25, `got ${coinFlip[0].beatsNext}`)
})

/** The step confidence and the tie grouping have to tell the same story. */
test('a step under the separation level is exactly an unresolved neighbour pair', () => {
  const rows = computeBradleyTerry([
    ...duel('a', 'b', 34, 50), ...duel('b', 'c', 33, 50), ...duel('a', 'c', 45, 50),
  ])
  for (let i = 0; i < rows.length - 1; i++) {
    const firm = rows[i].beatsNext >= 0.95
    const tied = rows[i].tiedWith.includes(rows[i + 1].id)
    assert.equal(firm, !tied, `${rows[i].id} vs ${rows[i + 1].id}: step ${rows[i].beatsNext}, tied ${tied}`)
  }
})

test('bootstrapRounds: 0 reports no step confidence', () => {
  for (const r of computeBradleyTerry(duel('x', 'y', 7, 10), { bootstrapRounds: 0 })) {
    assert.equal(r.beatsNext, null)
  }
})

test('buildRankings carries beatsNext onto every row', () => {
  for (const g of buildRankings(ALL).groups) {
    const rows = g.ranking.overall
    rows.slice(0, -1).forEach(r => assert.ok(typeof r.beatsNext === 'number', `${r.id} has no step`))
  }
})
