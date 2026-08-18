/**
 * rankings.js — Bradley-Terry scoring over pairwise records.
 *
 * Shared by the dev API (server/api.js) and the static build, so a deployed
 * read-only site ranks setups exactly the way `npm run dev` does. Everything
 * here has to run unchanged in Node and in the browser, which is why the only
 * import is schedule.js — itself pure, clock-free and dependency-free.
 */

import { layerOfPair, parseSetupId, connectivity } from './schedule.js'

export const DIMENSIONS = ['geometry', 'interactivity', 'faithfulness', 'labels', 'concept']

/**
 * Which layer of the design to rank over.
 *
 * The two layers answer different questions and mixing them hides that. Layer A
 * (ablation) only ever compares pipelines within one model, so a ranking built
 * from it alone says how the pipelines order — and says nothing whatsoever about
 * the models, since no two models ever meet. Layer B (rotation) is the only
 * place models are compared, but it sees each pair on fewer figures.
 *
 * 'all' is the default and the honest overall answer; the other two exist so a
 * claim about pipelines or about models can be read off the evidence that
 * actually supports it.
 */
export const LAYERS = ['all', 'ablation', 'rotation']

/**
 * 400 points per decade of odds — the transform that turns a BT strength into an
 * Elo-style rating. A 400-point gap is 10:1, i.e. a ~91% win probability.
 */
export const ELO_SCALE = 400 / Math.LN10

/**
 * Where the mean of a table sits. Arbitrary, as any BT anchor is: the model
 * identifies only differences, and only differences are read off the table.
 */
export const ELO_ANCHOR = 1000

/**
 * How far below the strongest setup a strength may fall before the log transform
 * is floored. BT has no finite estimate for a setup that never won — its
 * likelihood keeps rising as that strength goes to zero — so the honest options
 * are to print nothing or to pin it to a rail. It is pinned, at
 * ln(1e-6) x ELO_SCALE ~ 2400 points down, and its interval comes out wide
 * enough to say so.
 */
const STRENGTH_FLOOR_RATIO = 1e-6

/**
 * Bootstrap replicates. Arena uses ~100, which is plenty for an interval endpoint,
 * but the rank comes from a proportion tested against SEPARATION_LEVEL and a
 * proportion needs more replicates than a percentile does: at 200 rounds the
 * standard error near 0.95 is about 1.5 points, enough to move a borderline pair
 * across the line. 500 halves that and still fits in the panel's budget.
 */
const DEFAULT_BOOTSTRAP_ROUNDS = 500

/**
 * How often one setup has to come out ahead across the paired replicates before
 * the table is willing to rank it above another. The usual 95%.
 */
const SEPARATION_LEVEL = 0.95

/**
 * Seeded PRNG, so an interval is a property of the data and not of when it was
 * computed. A resampled CI that moved on every refresh would read as a bug.
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Zermelo's algorithm, the MLE iteration for Bradley-Terry — the same fixed point
 * as visionbook's server.js:computeBradleyTerry, over flat typed arrays rather
 * than string-keyed objects.
 *
 * The shape is what makes the interval affordable. A bootstrap wants a few hundred
 * refits, and the object-keyed version spent almost all of its time allocating an
 * n x n map of plain objects per replicate; indices and a Float64Array take the
 * whole panel from ~1s to well under 100ms, which is the difference between
 * shipping an interval and not.
 *
 * @param {number} n number of setups
 * @param {Int32Array} ai left setup index per comparison
 * @param {Int32Array} bi right setup index per comparison
 * @param {Float64Array} aw a's share of each comparison (1, 0.5 or 0)
 * @param {Int32Array|null} order which comparisons to fit over, by index into the
 *   arrays above; null means all of them, in order. A bootstrap replicate is just
 *   a different `order`, so resampling allocates one Int32Array and nothing else.
 * @param {Float64Array|null} p0 warm start
 * @returns {{p: Float64Array, seen: Uint8Array}}
 */
function solve(n, ai, bi, aw, order, p0, maxIter, tol) {
  const m = order ? order.length : ai.length
  const W = new Float64Array(n)
  const N = new Float64Array(n * n)
  const seen = new Uint8Array(n)

  for (let k = 0; k < m; k++) {
    const e = order ? order[k] : k
    const a = ai[e]
    const b = bi[e]
    const w = aw[e]
    W[a] += w
    W[b] += 1 - w
    N[a * n + b]++
    N[b * n + a]++
    seen[a] = 1
    seen[b] = 1
  }

  const p = new Float64Array(n)
  if (p0) p.set(p0)
  else p.fill(1)
  const next = new Float64Array(n)

  for (let iter = 0; iter < maxIter; iter++) {
    for (let i = 0; i < n; i++) {
      let denom = 0
      const row = i * n
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const nij = N[row + j]
        if (nij !== 0) denom += nij / (p[i] + p[j])
      }
      next[i] = denom > 0 ? W[i] / denom : p[i]
    }
    let total = 0
    for (let i = 0; i < n; i++) total += next[i]
    let maxChange = 0
    for (let i = 0; i < n; i++) {
      const norm = total > 0 ? next[i] / total : 1 / n
      const change = Math.abs(norm - p[i])
      if (change > maxChange) maxChange = change
      p[i] = norm
    }
    if (maxChange < tol) break
  }

  return { p, seen }
}

/**
 * Strengths to ratings: log, floored, then shifted so the table's mean lands on
 * ELO_ANCHOR.
 *
 * The log is what makes the number readable. `score` is normalised to sum to 1,
 * so it is a function of how many setups share the table: deselecting a setup
 * moves every remaining number, and each of the four ablation tables renormalises
 * to its own 100. On this scale that mechanical part of the movement is gone — a
 * gap between two setups is a property of the fit, so it means the same thing in
 * every table.
 *
 * @param {Float64Array} p
 * @returns {Float64Array}
 */
function toElo(p) {
  const n = p.length
  let maxP = 0
  for (let i = 0; i < n; i++) if (p[i] > maxP) maxP = p[i]
  const floor = maxP * STRENGTH_FLOOR_RATIO

  const raw = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    raw[i] = ELO_SCALE * Math.log(Math.max(p[i], floor))
    sum += raw[i]
  }
  const shift = ELO_ANCHOR - sum / n
  for (let i = 0; i < n; i++) raw[i] += shift
  return raw
}

/** Linear-interpolated percentile over an ascending array. */
function percentile(sorted, q) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const idx = q * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * Resample the comparisons with replacement and refit, which is how arena
 * quantifies a rating: the spread of the replicates is the spread of the
 * evidence.
 *
 * Every replicate refits *all* setups on the same resample, so the returned
 * ratings are paired across a row. That pairing is what makes a real comparison
 * possible later — see separate() — and it is thrown away by anything that only
 * keeps per-setup percentiles.
 *
 * @returns {{elo: Float64Array[], seen: Uint8Array[]}} one entry per replicate
 */
function bootstrapReplicates(n, ai, bi, aw, rounds, p0) {
  const rand = mulberry32(0x5EED)
  const elo = []
  const seen = []
  const m = ai.length
  const order = new Int32Array(m)

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < m; i++) order[i] = (rand() * m) | 0
    // Warm-started from the full-data fit and held to a looser tolerance: a
    // replicate only has to find its own optimum, not resolve it to 1e-8.
    const rep = solve(n, ai, bi, aw, order, p0, 100, 1e-6)
    elo.push(toElo(rep.p))
    seen.push(rep.seen)
  }

  return { elo, seen }
}

/**
 * P(i outranks j), read straight off the paired replicates.
 *
 * This replaces the obvious-looking test — do the two 95% intervals overlap? —
 * which is wrong twice over. It discards the pairing, comparing each setup against
 * its own marginal spread when both moved together in every replicate; and it is
 * a yes/no readout of a continuous quantity, so a sliver of tail overlap and near
 * total overlap both come back "cannot order these". On the real benchmark,
 * full-pipeline-gpt and baseline-gemini overlap by 15 rating points and the
 * interval rule calls them inseparable, while the paired replicates put
 * baseline-gemini ahead just 2.5% of the time. Testing the difference directly
 * takes separability across the whole table from 62% of pairs to 79%.
 *
 * @returns {Float64Array} n x n, entry i*n+j is P(i > j)
 */
function pairwiseWinShare(n, replicates) {
  const beats = new Float64Array(n * n)
  const both = new Float64Array(n * n)

  for (let r = 0; r < replicates.elo.length; r++) {
    const elo = replicates.elo[r]
    const seen = replicates.seen[r]
    for (let i = 0; i < n; i++) {
      if (!seen[i]) continue
      for (let j = 0; j < n; j++) {
        // A replicate that dropped one side says nothing about that pair.
        if (i === j || !seen[j]) continue
        both[i * n + j]++
        if (elo[i] > elo[j]) beats[i * n + j]++
      }
    }
  }

  for (let k = 0; k < n * n; k++) beats[k] = both[k] > 0 ? beats[k] / both[k] : 0.5
  return beats
}

/**
 * Bradley-Terry with a bootstrap interval, an adjacent-step confidence, and a
 * significance-based rank.
 *
 * `beatsNext` is the one the table leads with, because it is the only one of the
 * three that does not overstate something. A shared `rankUB` says two setups are
 * tied, which is not what the evidence found: it found that they cannot be *put in
 * an order*, while the ratings still differ and the table still draws one above the
 * other. Reading the shared rank as "equal" contradicts the bars sitting right
 * beside it. `beatsNext` says the true thing instead — this row is ahead of the
 * next, and here is how sure that is — and it is well defined because the
 * unresolved sets turn out to be contiguous in rating order, so all the doubt
 * lives in the step between neighbours.
 *
 * `rankUB` and `tiedWith` are kept for the arena-style reading and for the
 * separability summary, but they are not the primary label.
 *
 * @param {Array<{a: string, b: string, aWins: 0|0.5|1}>} matchups
 * @param {object} [options]
 * @param {number} [options.bootstrapRounds] 0 reports no interval, and rank falls
 *   back to the ordinal position.
 * @returns {Array<{id, score, elo, eloLow, eloHigh, beatsNext, rankUB, rankLB,
 *   tiedWith, wins, losses, ties, comparisons}>} sorted by score
 */
export function computeBradleyTerry(matchups, { bootstrapRounds = DEFAULT_BOOTSTRAP_ROUNDS } = {}) {
  const setups = [...new Set(matchups.flatMap(m => [m.a, m.b]))]
  const n = setups.length
  if (n === 0) return []

  const index = new Map(setups.map((s, i) => [s, i]))
  const m = matchups.length
  const ai = new Int32Array(m)
  const bi = new Int32Array(m)
  const aw = new Float64Array(m)
  const wins = new Int32Array(n)
  const losses = new Int32Array(n)
  const ties = new Int32Array(n)

  for (let k = 0; k < m; k++) {
    const a = index.get(matchups[k].a)
    const b = index.get(matchups[k].b)
    const w = matchups[k].aWins
    ai[k] = a
    bi[k] = b
    aw[k] = w
    if (w === 1) { wins[a]++; losses[b]++ }
    else if (w === 0) { losses[a]++; wins[b]++ }
    else { ties[a]++; ties[b]++ }
  }

  const { p } = solve(n, ai, bi, aw, null, null, 500, 1e-8)
  const elo = toElo(p)

  const replicates = bootstrapRounds > 0
    ? bootstrapReplicates(n, ai, bi, aw, bootstrapRounds, p)
    : null
  const beats = replicates ? pairwiseWinShare(n, replicates) : null

  // The marginal interval still drives the whisker in the table: it is the right
  // thing for showing how much a single rating is pinned down, and only the wrong
  // thing for comparing two of them.
  const bounds = setups.map((_, i) => {
    if (!replicates) return { low: null, high: null }
    const column = []
    for (let r = 0; r < replicates.elo.length; r++) {
      if (replicates.seen[r][i]) column.push(replicates.elo[r][i])
    }
    column.sort((a, b) => a - b)
    return { low: percentile(column, 0.025), high: percentile(column, 0.975) }
  })

  const rows = setups
    .map((id, i) => ({
      id,
      index: i,
      score: p[i],
      elo: elo[i],
      eloLow: bounds[i].low,
      eloHigh: bounds[i].high,
      wins: wins[i],
      losses: losses[i],
      ties: ties[i],
      comparisons: wins[i] + losses[i] + ties[i],
    }))
    .sort((a, b) => b.score - a.score)

  return rows.map((row, ordinal) => {
    if (!beats) {
      const { index: _drop, ...rest } = row
      return { ...rest, beatsNext: null, rankUB: ordinal + 1, rankLB: ordinal + 1, tiedWith: [] }
    }
    // The last row has no step below it to be confident about.
    const next = rows[ordinal + 1]
    const beatsNext = next ? beats[row.index * n + next.index] : null
    let better = 0
    let worse = 0
    const tiedWith = []
    for (const other of rows) {
      if (other === row) continue
      if (beats[other.index * n + row.index] >= SEPARATION_LEVEL) better++
      else if (beats[row.index * n + other.index] >= SEPARATION_LEVEL) worse++
      else tiedWith.push(other.id)
    }
    const { index: _drop, ...rest } = row
    return { ...rest, beatsNext, rankUB: 1 + better, rankLB: n - worse, tiedWith }
  })
}

/**
 * The probability BT assigns to `a` beating `b`, straight from the fit.
 *
 * The rating is an abstraction; this is not. It gives the table a column a reader
 * can act on without first learning what a point is worth.
 */
export function winProbability(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400))
}

/**
 * The minimum a record needs for ranking. The static exporter writes records in
 * exactly this shape so the browser can rank without downloading every rationale.
 */
export function trimRankingRecord(r) {
  const dims = {}
  for (const d of DIMENSIONS) {
    const w = r.machineEval?.dimensions?.[d]?.winner
    if (w) dims[d] = { winner: w }
  }
  const overall = r.machineEval?.aggregator?.winner
  const human = r.humanEvals?.[0]?.winner
  return {
    setupA: r.setupA,
    setupB: r.setupB,
    machineEval: overall || Object.keys(dims).length ? { aggregator: overall ? { winner: overall } : undefined, dimensions: dims } : undefined,
    humanEvals: human ? [{ winner: human }] : [],
  }
}

/**
 * @param {Array} records pairwise records (full or trimmed)
 * @param {string[]|null} allowedSetups restrict to comparisons where both sides
 *   are selected; null means no filter
 * @param {object} [options]
 * @param {'all'|'ablation'|'rotation'} [options.layer] which layer of the design
 *   to rank over — see LAYERS. Defaults to 'all'.
 * @returns {{machine: object, human: object, availableSetups: string[], layer: string}}
 */
/**
 * Split the ablation layer into one table per experiment model.
 *
 * Layer A only ever compares pipelines inside one model, so its comparison graph
 * is not one graph — it is four, with no edge between them. Bradley-Terry fits a
 * single scale, and fitting one across four disconnected components puts numbers
 * side by side that no comparison ever produced: over the 1200 ablation records
 * the combined table ranks `baseline-gemini` (12.80) directly above
 * `full-pipeline-qwen` (12.26), a claim layer A contains no evidence for. Worse,
 * the components hold equal data, so the scores land in a similar range and look
 * comparable. Split apart, each table sums to 100 and says only what it can.
 *
 * The other layers are left as a single group: the rotation is a 1-factorization
 * over every setup and is connected by construction, and splitting it by model
 * would destroy the only view in which two models ever meet.
 *
 * Grouping is by model rather than by measured connectivity so the table set is
 * the same four whatever a run has reached so far. Connectivity is still checked
 * *within* each group and reported as `connected`, which is what catches a model
 * whose own data is too sparse to rank.
 */
function groupRecords(filtered, layer) {
  if (layer !== 'ablation') return [{ key: 'all', label: null, records: filtered }]

  const byModel = new Map()
  for (const r of filtered) {
    const model = parseSetupId(r.setupA)?.model ?? 'other'
    if (!byModel.has(model)) byModel.set(model, [])
    byModel.get(model).push(r)
  }
  return [...byModel.keys()].sort().map(model => ({
    key: model,
    label: model,
    records: byModel.get(model),
  }))
}

/** Winner accessors — the one thing that differs between a judge and a human. */
const overallWinner = source => (
  source === 'human'
    ? r => r.humanEvals?.[0]?.winner
    : r => r.machineEval?.aggregator?.winner
)

function matchupsFrom(records, getWinner) {
  return records.flatMap(r => {
    const w = getWinner(r)
    if (!w || !r.setupA || !r.setupB) return []
    if (w !== r.setupA && w !== r.setupB && w !== 'tie') return []
    return [{ a: r.setupA, b: r.setupB, aWins: w === r.setupA ? 1 : w === 'tie' ? 0.5 : 0 }]
  })
}

/**
 * Rank one group. A human source has an overall ranking and nothing else — a
 * human verdict is a single choice, with no per-dimension breakdown to report.
 */
function rankGroup(records, source) {
  const ranking = { overall: computeBradleyTerry(matchupsFrom(records, overallWinner(source))) }
  if (source !== 'human') {
    for (const d of DIMENSIONS) {
      ranking[d] = computeBradleyTerry(matchupsFrom(records, r => r.machineEval?.dimensions?.[d]?.winner))
    }
  }
  return ranking
}

/**
 * @param {Array} records pairwise records (full or trimmed)
 * @param {string[]|null} allowedSetups restrict to comparisons where both sides
 *   are selected; null means no filter
 * @param {object} [options]
 * @param {'all'|'ablation'|'rotation'} [options.layer] which layer to rank over
 * @param {'machine'|'human'} [options.source] whose verdicts to rank by
 * @returns {{groups: Array, availableSetups: string[], layer: string, source: string}}
 *   `groups` always has at least the shape [{key, label, setups, ranking, connected}];
 *   it holds one entry for every layer but ablation, which holds one per model.
 */
export function buildRankings(records, allowedSetups = null, { layer = 'all', source = 'machine' } = {}) {
  // Taken before any filtering, so narrowing the layer or the setup selection
  // never removes entries from the picker that controls it.
  const availableSetups = [...new Set(records.flatMap(r => [r.setupA, r.setupB]).filter(Boolean))].sort()

  const allowed = allowedSetups ? new Set(allowedSetups) : null
  let filtered = allowed
    ? records.filter(r => allowed.has(r.setupA) && allowed.has(r.setupB))
    : records

  if (layer !== 'all') {
    filtered = filtered.filter(r => r.setupA && r.setupB && layerOfPair(r.setupA, r.setupB) === layer)
  }

  const groups = groupRecords(filtered, layer).map(g => {
    const ranking = rankGroup(g.records, source)
    // Connectivity over the verdicts this table is actually fitted on, not over
    // the records in the group: a comparison with no winner for this source
    // contributes no edge, so a table can be disconnected even when the group
    // looks complete.
    const edges = matchupsFrom(g.records, overallWinner(source)).map(m => [m.a, m.b])
    const setups = [...new Set(edges.flat())].sort()
    return {
      key: g.key,
      label: g.label,
      setups,
      ranking,
      // False means this table's scores are not all on one scale — see the note
      // on groupRecords. True for an empty table, which claims nothing.
      connected: connectivity(setups, edges).connected,
    }
  })

  return { groups, availableSetups, layer, source }
}
