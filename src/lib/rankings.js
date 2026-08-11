/**
 * rankings.js — Bradley-Terry scoring over pairwise records.
 *
 * Shared by the dev API (server/api.js) and the static build, so a deployed
 * read-only site ranks setups exactly the way `npm run dev` does. Pure JS with
 * no imports on purpose: it has to run in Node and in the browser.
 */

export const DIMENSIONS = ['geometry', 'interactivity', 'faithfulness', 'labels', 'concept']

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
 * @returns {{machine: object, human: object, availableSetups: string[]}}
 */
export function buildRankings(records, allowedSetups = null) {
  const availableSetups = [...new Set(records.flatMap(r => [r.setupA, r.setupB]).filter(Boolean))].sort()

  const allowed = allowedSetups ? new Set(allowedSetups) : null
  const filtered = allowed
    ? records.filter(r => allowed.has(r.setupA) && allowed.has(r.setupB))
    : records

  function buildMatchups(getWinner) {
    return filtered.flatMap(r => {
      const w = getWinner(r)
      if (!w || !r.setupA || !r.setupB) return []
      if (w !== r.setupA && w !== r.setupB && w !== 'tie') return []
      return [{ a: r.setupA, b: r.setupB, aWins: w === r.setupA ? 1 : w === 'tie' ? 0.5 : 0 }]
    })
  }

  const machine = {
    overall: computeBradleyTerry(buildMatchups(r => r.machineEval?.aggregator?.winner)),
  }
  for (const d of DIMENSIONS) {
    machine[d] = computeBradleyTerry(buildMatchups(r => r.machineEval?.dimensions?.[d]?.winner))
  }

  const human = {
    overall: computeBradleyTerry(buildMatchups(r => r.humanEvals?.[0]?.winner)),
  }

  return { machine, human, availableSetups }
}
