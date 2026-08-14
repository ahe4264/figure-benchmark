/**
 * schedule.js — which (setup pair, figure) comparisons to actually run.
 *
 * A full round robin over 12 setups is C(12,2) × 100 = 6600 comparisons, and each
 * one costs six model calls. This builds a two-layer incomplete design instead:
 *
 *   Layer A — "ablation": every within-model pipeline pair, on every figure.
 *     These are the contrasts a results table quotes outright ("the full pipeline
 *     beats baseline on 63% of figures"), so they need enough figures to carry a
 *     win rate on their own.
 *
 *   Layer B — "rotation": a 1-factorization of the complete graph, built with the
 *     circle method used to draw round-robin fixtures. For 12 setups that is 11
 *     rounds of 6 disjoint matches which between them cover all 66 pairs exactly
 *     once. Each figure draws `passes` of those rounds, so every setup takes part
 *     in exactly `passes` comparisons per figure and every pair is seen on many
 *     different figures.
 *
 * The split follows from what Bradley-Terry needs. It fits one score per setup on
 * a shared scale and only requires the comparison graph to be *connected*, not
 * complete — pairs that are never run still get an implied win rate through the
 * chain of pairs that were. Layer B buys that connectivity at minimum cost and
 * keeps every setup equally represented; layer A buys the quotable numbers.
 *
 * The two layers answer different questions and neither substitutes for the other.
 * Layer A is the only source of a standalone per-pair win rate, and layer B is the
 * *only* source of information about how the models compare, since layer A never
 * puts two models against each other. That asymmetry is why the pass count is not
 * a free parameter — see DEFAULT_PASSES for what the simulation says it costs.
 *
 * Everything here is a pure function of (setups, figures, seed): no I/O, no clock,
 * no Math.random. That is what makes a half-finished run recoverable — build the
 * same schedule again, subtract whatever the judge's results directory holds, and
 * what remains is exactly the work that was missed. It also means the browser can
 * display the plan without a server, the way src/lib/rankings.js is shared.
 */

import { canonicalizePair, pairKey } from './pairs.js'

/** Figure lists arrive as scanSetups() rows (`stem`) or joined rows (`name`). */
const stemOf = f => f.stem ?? f.name

// ── Deterministic randomness ──────────────────────────────────────────────────
// Seeded so that two runs of the scheduler agree. A schedule that reshuffled on
// every invocation could not be resumed: a retry would deal different pairs onto
// the figures that failed, and the balance the design depends on would be gone.

function hashString(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle(items, seed) {
  const rand = mulberry32(hashString(seed))
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

// ── Setup identity ────────────────────────────────────────────────────────────

/**
 * Split `full-pipeline-gemini_FINAL` into its pipeline and model halves.
 *
 * The convention is `<pipeline>-<model>[_TAG]`, and the model never contains a
 * dash, so the last dash is the split point. Anything that does not fit returns
 * null rather than throwing: a setup the scheduler cannot classify simply drops
 * out of layer A and is still covered by layer B, which needs no naming
 * convention at all.
 */
export function parseSetupId(id) {
  const m = /^(.+)-([^-]+)$/.exec(String(id).replace(/_[A-Za-z0-9]+$/, ''))
  return m ? { pipeline: m[1], model: m[2] } : null
}

/**
 * The within-model groups layer A compares inside — one group per model, holding
 * the model fixed so that only the pipeline varies. Groups of one are dropped:
 * there is nothing to compare.
 */
export function defaultAblationGroups(ids) {
  const byModel = new Map()
  for (const id of [...ids].sort()) {
    const parsed = parseSetupId(id)
    if (!parsed) continue
    if (!byModel.has(parsed.model)) byModel.set(parsed.model, [])
    byModel.get(parsed.model).push(id)
  }
  return [...byModel.keys()].sort().map(k => byModel.get(k)).filter(g => g.length >= 2)
}

/**
 * Which layer a *finished* comparison came from, recovered from the pair alone.
 *
 * Results files store no layer field, and they do not need to: layer A is defined
 * as the within-model pipeline pairs, so two setups sharing a model is exactly
 * what it means for a comparison to be an ablation. A rotation fixture that
 * happens to deal such a pair is deduplicated against layer A in buildSchedule
 * (see the `seen` set), so no comparison is ever recorded twice under different
 * layers and this classification is total.
 *
 * A setup id that does not parse cannot be in an ablation group —
 * defaultAblationGroups skips it — so it can only have reached the results
 * through the rotation.
 *
 * @returns {'ablation'|'rotation'}
 */
export function layerOfPair(setupA, setupB) {
  const a = parseSetupId(setupA)
  const b = parseSetupId(setupB)
  if (!a || !b) return 'rotation'
  return a.model === b.model ? 'ablation' : 'rotation'
}

// ── The round-robin rotation ──────────────────────────────────────────────────

/**
 * A 1-factorization of the complete graph on n vertices, by the circle method:
 * hold vertex 0 still and rotate the rest one position per round. Yields n-1
 * rounds (n even) of n/2 disjoint matches, together covering every pair exactly
 * once. An odd n gets a bye, so those rounds hold (n-1)/2 matches and the whole
 * schedule still covers each pair once.
 *
 * @returns {Array<Array<[number, number]>>} rounds of index pairs
 */
export function oneFactorization(n) {
  if (n < 2) return []
  const players = Array.from({ length: n }, (_, i) => i)
  if (n % 2 === 1) players.push(-1) // bye
  const m = players.length

  const rounds = []
  for (let r = 0; r < m - 1; r++) {
    const matches = []
    for (let i = 0; i < m / 2; i++) {
      const a = players[i]
      const b = players[m - 1 - i]
      if (a !== -1 && b !== -1) matches.push(a < b ? [a, b] : [b, a])
    }
    rounds.push(matches)
    players.splice(1, 0, players.pop()) // rotate everything but the fixed vertex
  }
  return rounds
}

// ── The schedule ──────────────────────────────────────────────────────────────

/**
 * Rotation rounds dealt to each figure.
 *
 * One pass is enough to connect the graph and to carry the ablation claim, but it
 * is not enough to *rank the models*, and simulation is what settled the number.
 * Layer A contributes nothing at all here — it never compares across models — so
 * every model comparison rests on the rotation alone.
 *
 * Recovering the exact 4-model order, at a 60% ablation gap with a setup×figure
 * sd of 0.5 and a 10% tie rate, over 400 replicates:
 *
 *   models 65% apart      1 pass 50%   2: 61%   3: 68%   4: 73%   round robin 85%
 *   models 70% apart      1 pass 66%   2: 78%   3: 86%   4: 91%   round robin 96%
 *
 * Three is the knee: it costs ~1000 comparisons over one pass and buys ~18 points,
 * where the fourth buys 5. At three passes the plan is 2675 comparisons against a
 * round robin's 6600 — still 2.5× cheaper, and no longer under-powered on the half
 * of the question layer A cannot speak to.
 *
 * Raise it if the models turn out to be closely matched, lower it to 2 if the
 * first pass shows them well separated. Passes are cumulative, so that decision
 * can be made after seeing results rather than before.
 */
export const DEFAULT_PASSES = 3

/** Stable identity for one unit of work: a pair judged on one figure. */
export function jobKey(job) {
  return `${job.pair}\u0000${job.stem}`
}

/**
 * Build the full two-layer schedule.
 *
 * @param {string[]} setups   setup ids (experiments/ subfolder names)
 * @param {Array<{stem?, name?, subject, type}>} figures figures every setup has
 * @param {object} [options]
 * @param {string} [options.seed]           changes which figure draws which round
 * @param {Array<string[]>} [options.ablationGroups] overrides the model grouping
 * @param {boolean} [options.includeAblation]
 * @param {boolean} [options.includeRotation]
 * @param {number} [options.passes] rotation rounds per figure (see DEFAULT_PASSES)
 * @returns {Array<{setupA, setupB, pair, stem, subject, type, layer, round}>}
 *   sorted by pair then stem, so a plan file diffs cleanly between runs
 */
export function buildSchedule(setups, figures, options = {}) {
  const {
    seed = 'figure-benchmark-v1',
    ablationGroups = null,
    includeAblation = true,
    includeRotation = true,
    passes = DEFAULT_PASSES,
  } = options

  const ids = [...new Set(setups)].sort()
  // Sorted before anything else reads them, so the plan is a function of *which*
  // figures were passed and not of what order they arrived in. matchingFigures()
  // orders by one setup's directory listing, which is not something the schedule
  // should be able to notice.
  const figureList = [...figures].sort((a, b) => (
    stemOf(a) < stemOf(b) ? -1 : stemOf(a) > stemOf(b) ? 1 : 0
  ))
  const jobs = []
  const seen = new Set()

  const push = (a, b, figure, layer, round) => {
    const { canonical1, canonical2 } = canonicalizePair(a, b)
    const job = {
      setupA: canonical1,
      setupB: canonical2,
      pair: pairKey(canonical1, canonical2),
      stem: stemOf(figure),
      subject: figure.subject,
      type: figure.type,
      layer,
      round,
    }
    const key = jobKey(job)
    // Layer A runs first, so a pair it already covers in full keeps its own label
    // when the rotation deals it again. Without this the same comparison would be
    // queued twice and the second one would be a wasted six model calls.
    if (seen.has(key)) return
    seen.add(key)
    jobs.push(job)
  }

  if (includeAblation) {
    for (const members of ablationGroups ?? defaultAblationGroups(ids)) {
      const group = [...members].sort()
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          for (const f of figureList) push(group[i], group[j], f, 'ablation', null)
        }
      }
    }
  }

  if (includeRotation && ids.length >= 2 && passes > 0) {
    const rounds = oneFactorization(ids.length)
    // Figures are shuffled before being dealt rounds so that a round is not
    // systematically tied to one subject — figures.json is grouped by subject, and
    // dealing in file order would hand every chemistry figure the same fixtures.
    seededShuffle(figureList, `${seed}:rounds`).forEach((f, i) => {
      // Consecutive rounds from the figure's own offset. Written this way so that
      // raising `passes` only ever *adds* fixtures: the rounds a figure draws at
      // k passes are a prefix of the ones it draws at k+1. That is what lets a run
      // be bought one pass at a time — evaluate a pass, look at the spread, decide
      // whether the next is worth it — without invalidating anything already done.
      for (let p = 0; p < Math.min(passes, rounds.length); p++) {
        const r = (i + p) % rounds.length
        for (const [x, y] of rounds[r]) push(ids[x], ids[y], f, 'rotation', r)
      }
    })
  }

  return jobs.sort((a, b) => (
    a.pair < b.pair ? -1 : a.pair > b.pair ? 1
      : a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0
  ))
}

/** Schedule entries with no result yet. `done` is a Set of jobKey strings. */
export function outstandingJobs(schedule, done) {
  return schedule.filter(j => !done.has(jobKey(j)))
}

// ── Design integrity ──────────────────────────────────────────────────────────

/**
 * Is the graph of *completed* comparisons connected over `ids`?
 *
 * This is the failure mode worth guarding, because it is silent. Bradley-Terry
 * happily returns a number for every setup in a disconnected graph, but scores in
 * one component are not comparable with scores in another — the fit has no
 * evidence tying them together. A run that lost a whole pair to repeated API
 * errors can land there without anything else looking wrong.
 *
 * @returns {{connected: boolean, components: string[][]}}
 */
export function connectivity(ids, edges) {
  const parent = new Map(ids.map(id => [id, id]))
  const find = x => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  for (const [a, b] of edges) {
    if (!parent.has(a) || !parent.has(b)) continue
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const groups = new Map()
  for (const id of ids) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  const components = [...groups.values()]
    .map(g => g.sort())
    .sort((a, b) => b.length - a.length)
  return { connected: components.length <= 1, components }
}

/**
 * Coverage, balance and connectivity of a schedule against what is already done.
 * `warnings` is the part worth reading after a run: it names the ways the design
 * has drifted from what was planned rather than leaving them to be noticed later
 * in a ranking that looks subtly wrong.
 */
export function scheduleReport(schedule, done = new Set(), ids = null) {
  const setups = ids ?? [...new Set(schedule.flatMap(j => [j.setupA, j.setupB]))].sort()

  const planned = Object.fromEntries(setups.map(s => [s, 0]))
  const complete = Object.fromEntries(setups.map(s => [s, 0]))
  const byLayer = {}
  const pairsPlanned = new Set()
  const pairsDone = new Set()
  const doneEdges = []
  let doneCount = 0

  for (const job of schedule) {
    const isDone = done.has(jobKey(job))
    if (isDone) doneCount++
    pairsPlanned.add(job.pair)
    if (!byLayer[job.layer]) byLayer[job.layer] = { planned: 0, done: 0 }
    byLayer[job.layer].planned++
    for (const s of [job.setupA, job.setupB]) {
      if (planned[s] === undefined) continue
      planned[s]++
      if (isDone) complete[s]++
    }
    if (isDone) {
      byLayer[job.layer].done++
      pairsDone.add(job.pair)
      doneEdges.push([job.setupA, job.setupB])
    }
  }

  const counts = setups.map(s => complete[s])
  const { connected, components } = connectivity(setups, doneEdges)

  const warnings = []
  if (!connected) {
    warnings.push(
      `completed comparisons form ${components.length} disconnected groups — Bradley-Terry scores are NOT comparable across them: ` +
      components.map(c => `[${c.join(', ')}]`).join(' | ')
    )
  }
  for (const s of setups) {
    if (planned[s] === 0) warnings.push(`${s} appears in no scheduled comparison`)
    else if (complete[s] === 0) warnings.push(`${s} has no completed comparison yet`)
  }
  // The plan is balanced to within a comparison or two, not exactly. A rotation
  // fixture that layer A already covers cannot be run a second time — a pair and
  // figure have one result slot — so it is dropped, and which setups lose a fixture
  // that way depends on the rounds they happen to draw. On the real 12×100 set that
  // residue is 1 comparison in ~445. Anything beyond this tolerance is missing work
  // rather than design, which is what makes it worth reporting.
  if (doneCount === schedule.length && counts.length > 0) {
    const spread = Math.max(...counts) - Math.min(...counts)
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length
    const tolerance = Math.max(2, Math.ceil(mean * 0.01))
    if (spread > tolerance) {
      warnings.push(`comparison counts per setup vary by ${spread} (tolerance ${tolerance}) — some jobs are missing`)
    }
  }

  return {
    total: schedule.length,
    done: doneCount,
    remaining: schedule.length - doneCount,
    byLayer,
    pairs: { planned: pairsPlanned.size, started: pairsDone.size },
    perSetup: Object.fromEntries(setups.map(s => [s, { planned: planned[s], done: complete[s] }])),
    balance: counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null,
    connected,
    components,
    warnings,
  }
}

// ── Position counterbalancing ─────────────────────────────────────────────────

/**
 * Decide which side of a pair occupies the Figure 1 slot, for every figure.
 *
 * LLM judges have a well-documented position bias, and the evaluator holds one
 * assignment across all five dimension agents and the aggregator — so whatever
 * bias exists is not averaged out within a figure, it is baked into that figure's
 * verdict. A per-figure coin flip only balances the two sides in expectation; over
 * 100 figures a 56/44 split is unremarkable, and that imbalance lands directly on
 * the win rate.
 *
 * Alternating instead pins the split down: exact where a stratum holds an even
 * number of figures, off by no more than one where it is odd, instead of drifting
 * by however much the coin happened to drift. Three details make it a proper
 * counterbalance rather than just an alternation:
 *
 *   - it alternates within each subject × type stratum, so the halves are balanced
 *     inside every subgroup the results are ever broken down by, not just overall;
 *     the strata here are odd-sized (physics is 10/15 on 2d/3d, chemistry 12/13),
 *     so each contributes at most one unpaired figure, and the per-pair offset
 *     below seats those leftovers on opposite sides in different pairs;
 *   - it starts from a per-pair offset, so a given figure does not seat the same
 *     side first in every pair it appears in, which would tie position to figure;
 *   - it is a pure function of (pair, figure), so a re-run after a failure
 *     reproduces the original seating rather than quietly re-rolling it.
 *
 * @returns {Map<string, {figure1: string, figure2: string}>} keyed by stem
 */
export function positionAssignments(setupA, setupB, figures) {
  const { canonical1, canonical2 } = canonicalizePair(setupA, setupB)
  const offset = hashString(pairKey(canonical1, canonical2)) % 2

  const strata = new Map()
  for (const f of figures) {
    const key = `${f.subject ?? '?'}__${f.type ?? '?'}`
    if (!strata.has(key)) strata.set(key, [])
    strata.get(key).push(f)
  }

  // One alternation running across the strata rather than restarting inside each.
  // Restarting leaves every odd-sized stratum with its spare figure on the same
  // side, and those biases add up: on the real set (four odd strata) that came out
  // 52/100 overall. Carrying the counter makes each stratum's leftover fall on the
  // opposite side to the last one, so the strata stay balanced to within a figure
  // *and* the total comes out exactly even.
  const out = new Map()
  let i = offset
  for (const key of [...strata.keys()].sort()) {
    const group = [...strata.get(key)].sort((a, b) => (
      stemOf(a) < stemOf(b) ? -1 : stemOf(a) > stemOf(b) ? 1 : 0
    ))
    for (const f of group) {
      out.set(stemOf(f), i % 2 === 0
        ? { figure1: canonical1, figure2: canonical2 }
        : { figure1: canonical2, figure2: canonical1 })
      i++
    }
  }
  return out
}
