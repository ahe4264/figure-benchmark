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
 * Ported verbatim from visionbook's server.js:computeBradleyTerry.
 *
 * @param {Array<{a: string, b: string, aWins: 0|0.5|1}>} matchups
 * @returns {Array<{id, score, wins, losses, ties, comparisons}>} sorted by score
 */
export function computeBradleyTerry(matchups) {
  const setupSet = new Set(matchups.flatMap(m => [m.a, m.b]))
  const setups = [...setupSet]
  if (setups.length === 0) return []

  const W = Object.fromEntries(setups.map(s => [s, 0]))
  const rawWins = Object.fromEntries(setups.map(s => [s, 0]))
  const rawLosses = Object.fromEntries(setups.map(s => [s, 0]))
  const rawTies = Object.fromEntries(setups.map(s => [s, 0]))
  const Nij = {}
  for (const s of setups) Nij[s] = Object.fromEntries(setups.map(t => [t, 0]))

  for (const { a, b, aWins } of matchups) {
    W[a] += aWins
    W[b] += (1 - aWins)
    Nij[a][b]++
    Nij[b][a]++
    if (aWins === 1) { rawWins[a]++; rawLosses[b]++ }
    else if (aWins === 0) { rawLosses[a]++; rawWins[b]++ }
    else { rawTies[a]++; rawTies[b]++ }
  }

  const p = Object.fromEntries(setups.map(s => [s, 1]))
  for (let iter = 0; iter < 500; iter++) {
    const newP = {}
    for (const i of setups) {
      let denom = 0
      for (const j of setups) {
        if (j !== i) denom += Nij[i][j] / (p[i] + p[j])
      }
      newP[i] = denom > 0 ? W[i] / denom : p[i]
    }
    const total = setups.reduce((acc, s) => acc + newP[s], 0)
    let maxChange = 0
    for (const s of setups) {
      const norm = total > 0 ? newP[s] / total : 1 / setups.length
      maxChange = Math.max(maxChange, Math.abs(norm - p[s]))
      p[s] = norm
    }
    if (maxChange < 1e-8) break
  }

  return setups
    .map(id => ({
      id,
      score: p[id],
      wins: rawWins[id],
      losses: rawLosses[id],
      ties: rawTies[id],
      comparisons: rawWins[id] + rawLosses[id] + rawTies[id],
    }))
    .sort((a, b) => b.score - a.score)
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
