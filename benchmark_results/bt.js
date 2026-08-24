/**
 * bt.js — Bradley-Terry rankings over the pairwise result files in this folder.
 *
 * Runs as a classic script rather than an ES module, because `import` is blocked
 * under file:// and the page is meant to work when index.html is opened directly.
 *
 * The fit (through buildRankings) is a port of src/lib/rankings.js from the
 * figure-benchmark app, verified to produce identical output. Everything from the
 * `state` declaration down is this page's own loading and rendering.
 */
(function () {
  'use strict'

  const DIMENSIONS = ['geometry', 'interactivity', 'faithfulness', 'labels', 'concept']
  const DIM_LABELS = {
    geometry: 'Geom',
    interactivity: 'Interact',
    faithfulness: 'Faith',
    labels: 'Labels',
    concept: 'Concept',
  }

  const LAYERS = ['all', 'ablation', 'rotation']
  const LAYER_LABELS = { all: 'All', ablation: 'Ablation', rotation: 'Rotation' }
  const LAYER_TITLES = {
    all: 'Every comparison in the design',
    ablation: 'Layer A only - pipelines within one model. Says nothing about the models: no two models ever meet here.',
    rotation: 'Layer B only - the cross-model round robin. The only evidence that compares models.',
  }

  /** One entry per result subdirectory. `kind` selects which verdict field is read. */
  const SOURCES = [
    { dir: 'gemini', label: 'Gemini 3.1 Pro', kind: 'machine' },
    { dir: 'gpt5.5', label: 'GPT-5.5', kind: 'machine' },
    { dir: 'human', label: 'Human', kind: 'human' },
  ]

  /** 400 points per decade of odds: a 400-point gap is 10:1, a ~91% win probability. */
  const ELO_SCALE = 400 / Math.LN10

  /** Where each table's mean sits. Arbitrary — only rating differences are identified. */
  const ELO_ANCHOR = 1000

  /**
   * How far below the strongest setup a strength may fall before the log is floored.
   * A setup that never won has no finite BT estimate, so it is pinned to this rail
   * (~2400 points down) and its interval comes out wide enough to say so.
   */
  const STRENGTH_FLOOR_RATIO = 1e-6

  /** Bootstrap replicates behind every interval and every ordering claim. */
  const DEFAULT_BOOTSTRAP_ROUNDS = 500

  /** How often one setup must come out ahead before the table will order the pair. */
  const SEPARATION_LEVEL = 0.95

  /** Below this, the rule under a row is drawn dashed instead of solid. */
  const STEP_FIRM = 0.95

  // ── Bradley-Terry ───────────────────────────────────────────────────────────

  /**
   * Seeded PRNG, so an interval is a property of the data and not of when it was
   * computed. A resampled CI that moved on every reload would read as a bug.
   *
   * @param {number} seed
   * @returns {() => number} successive values in [0, 1)
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
   * Zermelo's algorithm — the maximum-likelihood fixed point for Bradley-Terry.
   *
   * Written over flat typed arrays rather than string-keyed objects because a
   * bootstrap needs hundreds of refits; indices and a Float64Array are what make
   * an interval affordable at page load.
   *
   * @param {number} n number of setups
   * @param {Int32Array} ai left setup index per comparison
   * @param {Int32Array} bi right setup index per comparison
   * @param {Float64Array} aw a's share of each comparison (1, 0.5 or 0)
   * @param {Int32Array|null} order which comparisons to fit over, as indices into
   *   the arrays above; null means all of them. A bootstrap replicate is just a
   *   different `order`, so resampling allocates one array and nothing else.
   * @param {Float64Array|null} p0 warm start, or null to start uniform
   * @param {number} maxIter
   * @param {number} tol stop once no strength moves by more than this
   * @returns {{p: Float64Array, seen: Uint8Array}} normalised strengths, and which
   *   setups appeared in at least one comparison
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
   * The log is what makes the number readable. Strengths are normalised to sum to
   * 1, so they depend on how many setups share the table — deselecting a setup
   * would move every remaining number. On this scale that mechanical movement is
   * gone, so a gap between two rows means the same thing in every table.
   *
   * @param {Float64Array} p normalised strengths
   * @returns {Float64Array} ratings, mean ELO_ANCHOR
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

  /**
   * Linear-interpolated percentile over an ascending array.
   *
   * @param {number[]} sorted ascending
   * @param {number} q in [0, 1]
   * @returns {number|null} null for an empty array
   */
  function percentile(sorted, q) {
    if (sorted.length === 0) return null
    if (sorted.length === 1) return sorted[0]
    const idx = q * (sorted.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }

  /**
   * Resample the comparisons with replacement and refit, which is how the spread
   * of the evidence becomes the spread of a rating.
   *
   * Every replicate refits *all* setups on the same resample, so ratings are paired
   * across a row. That pairing is what makes pairwiseWinShare possible, and it is
   * exactly what per-setup percentiles throw away.
   *
   * Replicates are warm-started from the full-data fit and held to a looser
   * tolerance: a replicate only has to find its own optimum, not resolve it to 1e-8.
   *
   * @param {number} n
   * @param {Int32Array} ai
   * @param {Int32Array} bi
   * @param {Float64Array} aw
   * @param {number} rounds
   * @param {Float64Array} p0 full-data fit, used as the warm start
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
   * which is wrong twice over. It discards the pairing, comparing each setup
   * against its own marginal spread when both moved together in every replicate;
   * and it is a yes/no readout of a continuous quantity, so a sliver of tail
   * overlap and near-total overlap both come back "cannot order these".
   *
   * A replicate that dropped one side of a pair says nothing about that pair, so
   * it is excluded from that cell's denominator rather than counted as a loss.
   *
   * @param {number} n
   * @param {{elo: Float64Array[], seen: Uint8Array[]}} replicates
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
   * `beatsNext` is what the table leads with, because it is the only one of the
   * three that does not overstate something. A shared `rankUB` says two setups are
   * tied, which is not what the evidence found: it found that they cannot be *put
   * in an order*, while the ratings still differ and the table still draws one
   * above the other. `beatsNext` says the true thing instead — this row is ahead of
   * the next, and here is how sure that is — and it is well defined because the
   * unresolved sets turn out to be contiguous in rating order, so all the doubt
   * lives in the step between neighbours.
   *
   * @param {Array<{a: string, b: string, aWins: 0|0.5|1}>} matchups
   * @param {{bootstrapRounds?: number}} [options] 0 reports no interval, and rank
   *   falls back to the ordinal position
   * @returns {Array<object>} one row per setup, sorted by strength descending, each
   *   carrying id, score, elo, eloLow/eloHigh, beatsNext, rankUB/rankLB, tiedWith,
   *   and wins/losses/ties/comparisons
   */
  function computeBradleyTerry(matchups, options = {}) {
    const bootstrapRounds = options.bootstrapRounds ?? DEFAULT_BOOTSTRAP_ROUNDS

    const setups = []
    const indexOf = new Map()
    for (const { a, b } of matchups) {
      if (!indexOf.has(a)) { indexOf.set(a, setups.length); setups.push(a) }
      if (!indexOf.has(b)) { indexOf.set(b, setups.length); setups.push(b) }
    }

    const n = setups.length
    if (n === 0) return []

    const m = matchups.length
    const ai = new Int32Array(m)
    const bi = new Int32Array(m)
    const aw = new Float64Array(m)
    const wins = new Int32Array(n)
    const losses = new Int32Array(n)
    const ties = new Int32Array(n)

    for (let k = 0; k < m; k++) {
      const a = indexOf.get(matchups[k].a)
      const b = indexOf.get(matchups[k].b)
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

    // The marginal interval drives the whisker: it is the right thing for showing
    // how much a single rating is pinned down, and only the wrong thing for
    // comparing two of them, which is what `beats` is for.
    const bounds = setups.map((_, i) => {
      if (!replicates) return { low: null, high: null }
      const column = []
      for (let r = 0; r < replicates.elo.length; r++) {
        if (replicates.seen[r][i]) column.push(replicates.elo[r][i])
      }
      column.sort((x, y) => x - y)
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
      .sort((x, y) => y.score - x.score)

    return rows.map((row, ordinal) => {
      const { index, ...rest } = row
      if (!beats) {
        return { ...rest, beatsNext: null, rankUB: ordinal + 1, rankLB: ordinal + 1, tiedWith: [] }
      }

      // The last row has no step below it to be confident about.
      const next = rows[ordinal + 1]
      const beatsNext = next ? beats[index * n + next.index] : null

      let better = 0
      let worse = 0
      const tiedWith = []
      for (const other of rows) {
        if (other === row) continue
        if (beats[other.index * n + index] >= SEPARATION_LEVEL) better++
        else if (beats[index * n + other.index] >= SEPARATION_LEVEL) worse++
        else tiedWith.push(other.id)
      }

      return { ...rest, beatsNext, rankUB: 1 + better, rankLB: n - worse, tiedWith }
    })
  }

  // ── Setup identity and design layers ────────────────────────────────────────

  /**
   * Split `full-pipeline-gemini_FINAL` into its pipeline and model halves.
   *
   * The convention is `<pipeline>-<model>[_TAG]` and the model never contains a
   * dash, so the last dash is the split point. Anything that does not fit returns
   * null rather than throwing.
   *
   * @param {string} id
   * @returns {{pipeline: string, model: string}|null}
   */
  function parseSetupId(id) {
    const m = /^(.+)-([^-]+)$/.exec(String(id).replace(/_[A-Za-z0-9]+$/, ''))
    return m ? { pipeline: m[1], model: m[2] } : null
  }

  /**
   * Which layer of the design a finished comparison came from, recovered from the
   * pair alone. Layer A is defined as the within-model pipeline pairs, so two
   * setups sharing a model is exactly what makes a comparison an ablation.
   *
   * @param {string} setupA
   * @param {string} setupB
   * @returns {'ablation'|'rotation'}
   */
  function layerOfPair(setupA, setupB) {
    const a = parseSetupId(setupA)
    const b = parseSetupId(setupB)
    if (!a || !b) return 'rotation'
    return a.model === b.model ? 'ablation' : 'rotation'
  }

  /**
   * Is the graph of completed comparisons connected over `ids`?
   *
   * Worth guarding because the failure is silent: Bradley-Terry happily returns a
   * number for every setup in a disconnected graph, but scores in one component
   * are not comparable with scores in another — no evidence ties them together.
   *
   * @param {string[]} ids
   * @param {Array<[string, string]>} edges
   * @returns {{connected: boolean, components: string[][]}} components largest first
   */
  function connectivity(ids, edges) {
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
   * Split the ablation layer into one table per experiment model.
   *
   * Layer A only ever compares pipelines inside one model, so its comparison graph
   * is not one graph — it is four, with no edge between them. Fitting a single
   * scale across four disconnected components puts numbers side by side that no
   * comparison ever produced, and because the components hold equal data those
   * numbers land in a similar range and look comparable. Split apart, each table
   * says only what it can.
   *
   * Other layers stay as one group: the rotation is connected by construction, and
   * splitting it by model would destroy the only view in which two models meet.
   *
   * @param {Array} filtered records already restricted to the layer
   * @param {'all'|'ablation'|'rotation'} layer
   * @returns {Array<{key: string, label: string|null, records: Array}>}
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

  /**
   * The overall-winner accessor for a source — the one thing that differs between
   * a judge and a human.
   *
   * @param {'machine'|'human'} source
   * @returns {(record: object) => string|undefined}
   */
  function overallWinner(source) {
    return source === 'human'
      ? r => r.humanEvals?.[0]?.winner
      : r => r.machineEval?.aggregator?.winner
  }

  /**
   * Records to matchups, dropping anything with no usable verdict.
   *
   * @param {Array} records
   * @param {(record: object) => string|undefined} getWinner
   * @returns {Array<{a: string, b: string, aWins: 0|0.5|1}>}
   */
  function matchupsFrom(records, getWinner) {
    const out = []
    for (const r of records) {
      const w = getWinner(r)
      if (!w || !r.setupA || !r.setupB) continue
      if (w !== r.setupA && w !== r.setupB && w !== 'tie') continue
      out.push({ a: r.setupA, b: r.setupB, aWins: w === r.setupA ? 1 : w === 'tie' ? 0.5 : 0 })
    }
    return out
  }

  /**
   * Rank one group. A human source has an overall ranking and nothing else — a
   * human verdict is a single choice, with no per-dimension breakdown to report.
   *
   * @param {Array} records
   * @param {'machine'|'human'} source
   * @returns {object} keyed by 'overall' and, for machine sources, each dimension
   */
  function rankGroup(records, source) {
    const ranking = { overall: computeBradleyTerry(matchupsFrom(records, overallWinner(source))) }
    if (source === 'human') return ranking

    for (const d of DIMENSIONS) {
      ranking[d] = computeBradleyTerry(
        matchupsFrom(records, r => r.machineEval?.dimensions?.[d]?.winner),
      )
    }
    return ranking
  }

  /**
   * Fit every table the current view needs.
   *
   * @param {Array} records pairwise records for one source
   * @param {string[]|null} allowedSetups keep only comparisons where both sides are
   *   selected; null means no filter
   * @param {{layer?: string, source?: 'machine'|'human'}} [options]
   * @returns {{groups: Array, layer: string, source: string}} one group for every
   *   layer but ablation, which holds one per model
   */
  function buildRankings(records, allowedSetups, options = {}) {
    const { layer = 'all', source = 'machine' } = options

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
        connected: connectivity(setups, edges).connected,
      }
    })

    return { groups, layer, source }
  }

  // ── Page state ──────────────────────────────────────────────────────────────

  /**
   * `records` and `counts` are keyed by result subdirectory. `selected` is null for
   * "every setup", which keeps the ordinary case out of the comparison in
   * selection(); an empty array means the user deselected them all.
   */
  const state = {
    records: {},
    counts: {},
    source: 'gemini',
    layer: 'all',
    dim: 'overall',
    selected: null,
    available: [],
    pairA: '',
    pairB: '',
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  /**
   * Build an element. `text` sets textContent, `class` sets className, keys
   * starting `on` bind listeners, anything else becomes an attribute. Null and
   * undefined attribute values are skipped.
   *
   * @param {string} tag
   * @param {object|null} [attrs]
   * @param {Array<Node|string|null>} [children]
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children = []) {
    const node = document.createElement(tag)

    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else if (v != null) node.setAttribute(k, v)
    }

    for (const child of children) {
      if (child == null) continue
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    }
    return node
  }

  /** @param {string} id @returns {HTMLElement} */
  const $ = id => document.getElementById(id)

  /**
   * Set the one-line status under the heading. An empty message hides it.
   *
   * @param {string} text
   * @param {'ok'|'error'} [kind]
   */
  function setStatus(text, kind) {
    const node = $('status')
    node.textContent = text || ''
    node.className = kind ? `status ${kind}` : 'status'
    node.style.display = text ? '' : 'none'
  }

  // ── Loading ─────────────────────────────────────────────────────────────────

  /**
   * Parse one pair file into records, tolerating anything malformed.
   *
   * A pair file is an object keyed by `<subject>__<figure>`; only the values
   * matter here, and only those carrying both setup ids are usable.
   *
   * @param {string} text
   * @returns {Array} records, empty if the file will not parse
   */
  function recordsFromFileText(text) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    if (!parsed || typeof parsed !== 'object') return []
    return Object.values(parsed).filter(r => r && r.setupA && r.setupB)
  }

  /**
   * Fold a subdirectory's file contents into state, replacing whatever was there.
   *
   * @param {string} dir
   * @param {string[]} texts
   */
  function ingest(dir, texts) {
    const records = texts.flatMap(recordsFromFileText)
    state.records[dir] = records
    state.counts[dir] = records.length
  }

  /** @returns {boolean} whether the page can fetch its own neighbours. */
  const isServed = () => location.protocol === 'http:' || location.protocol === 'https:'

  /**
   * Pull the .json filenames out of a server-generated directory listing.
   *
   * Works with any listing that links the files, which both `python3 -m
   * http.server` and `npx serve` produce by default. Returns an empty array for a
   * server with listings disabled, which is what makes the page fall back to the
   * folder picker rather than showing an empty table.
   *
   * @param {string} html
   * @returns {string[]} bare filenames, deduplicated
   */
  function listJsonHrefs(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const names = new Set()

    for (const a of doc.querySelectorAll('a[href]')) {
      const clean = a.getAttribute('href').split('?')[0].split('#')[0]
      if (!clean.toLowerCase().endsWith('.json')) continue
      const name = decodeURIComponent(clean).split('/').pop()
      if (name) names.add(name)
    }
    return [...names]
  }

  /**
   * Fetch many URLs with a bounded number in flight, reporting progress as each
   * lands. A failed or missing file yields '' rather than rejecting, so one bad
   * file cannot take down the whole load.
   *
   * @param {string[]} urls
   * @param {number} limit concurrent requests
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<string[]>} bodies, in the order the URLs were given
   */
  async function fetchAllLimited(urls, limit, onProgress) {
    const results = new Array(urls.length)
    let next = 0
    let done = 0

    const worker = async () => {
      while (next < urls.length) {
        const i = next++
        try {
          const res = await fetch(urls[i])
          results[i] = res.ok ? await res.text() : ''
        } catch {
          results[i] = ''
        }
        done++
        onProgress?.(done, urls.length)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(limit, urls.length) }, worker),
    )
    return results
  }

  /**
   * Discover and load every result file by fetching directory listings.
   *
   * @returns {Promise<boolean>} false if no files were found at all, which the
   *   caller treats as "this server cannot list directories"
   */
  async function loadOverHttp() {
    const plan = []
    for (const { dir } of SOURCES) {
      let html = ''
      try {
        const res = await fetch(`./${dir}/`)
        if (res.ok) html = await res.text()
      } catch {
        html = ''
      }
      plan.push({ dir, names: html ? listJsonHrefs(html) : [] })
    }

    const totalFiles = plan.reduce((a, p) => a + p.names.length, 0)
    if (totalFiles === 0) return false

    let seenFiles = 0
    for (const { dir, names } of plan) {
      const urls = names.map(n => `./${dir}/${encodeURIComponent(n)}`)
      const texts = await fetchAllLimited(urls, 12, () => {
        seenFiles++
        setStatus(`Reading results… ${seenFiles} / ${totalFiles} files`)
      })
      ingest(dir, texts)
    }
    return true
  }

  /**
   * Load from a folder the user chose or dropped.
   *
   * Files are routed by their immediate parent directory, so the name of the
   * folder that was picked does not matter — only that it contains `gemini/`,
   * `gpt5.5/` or `human/` somewhere directly beneath it. Picking a single judge
   * folder works for the same reason.
   *
   * @param {FileList|File[]} fileList entries carrying webkitRelativePath
   * @returns {Promise<boolean>} false if the folder held no result files
   */
  async function loadFromFileList(fileList) {
    const byDir = Object.fromEntries(SOURCES.map(s => [s.dir, []]))

    for (const f of fileList) {
      if (!f.name.toLowerCase().endsWith('.json')) continue
      const parts = (f.webkitRelativePath || f.name).split('/')
      const parent = parts.length >= 2 ? parts[parts.length - 2] : ''
      if (byDir[parent]) byDir[parent].push(f)
    }

    const picked = Object.values(byDir).reduce((a, files) => a + files.length, 0)
    if (picked === 0) return false

    let seenFiles = 0
    for (const { dir } of SOURCES) {
      const texts = await Promise.all(byDir[dir].map(async f => {
        const text = await f.text()
        seenFiles++
        setStatus(`Reading results… ${seenFiles} / ${picked} files`)
        return text
      }))
      ingest(dir, texts)
    }
    return true
  }

  /**
   * Flatten a drag-and-drop payload into files tagged with their relative paths.
   *
   * A dropped folder arrives as a directory entry rather than a file list, so it
   * has to be walked. `webkitRelativePath` is read-only on a File, hence the
   * defineProperty — it is what lets loadFromFileList treat dropped and picked
   * folders identically.
   *
   * @param {DataTransferItemList} items
   * @returns {Promise<File[]>}
   */
  async function collectDropped(items) {
    const entries = []
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }

    const files = []

    const readAllEntries = reader => new Promise(resolve => {
      const all = []
      const readBatch = () => {
        reader.readEntries(batch => {
          if (!batch.length) return resolve(all)
          all.push(...batch)
          readBatch()
        }, () => resolve(all))
      }
      readBatch()
    })

    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise(resolve => entry.file(resolve, () => resolve(null)))
        if (!file) return
        try {
          Object.defineProperty(file, 'webkitRelativePath', { value: prefix + entry.name })
        } catch {
          // Already defined by the browser; the existing value is good enough.
        }
        files.push(file)
        return
      }
      if (entry.isDirectory) {
        const children = await readAllEntries(entry.createReader())
        await Promise.all(children.map(c => walk(c, `${prefix + entry.name}/`)))
      }
    }

    await Promise.all(entries.map(e => walk(e, '')))
    return files
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  /** @returns {object} the SOURCES entry currently selected. */
  const activeSource = () => SOURCES.find(s => s.dir === state.source) ?? SOURCES[0]

  /** @returns {Array} records for the selected source. */
  const currentRecords = () => state.records[state.source] ?? []

  /**
   * Recompute the setup checkbox list from every loaded source, so switching
   * source never removes entries from the control that filters it.
   */
  function refreshAvailable() {
    const seen = new Set()
    for (const records of Object.values(state.records)) {
      for (const r of records) {
        if (r.setupA) seen.add(r.setupA)
        if (r.setupB) seen.add(r.setupB)
      }
    }
    state.available = [...seen].sort()
  }

  /** @returns {string[]} the effective setup selection, resolving null to "all". */
  const selection = () => state.selected ?? state.available

  // ── Rendering ───────────────────────────────────────────────────────────────

  /**
   * Tooltip for a rank cell, stating the confidence in the step to the row below
   * rather than the rank itself.
   *
   * @param {object} row
   * @returns {string}
   */
  function rankTitle(row) {
    if (row.beatsNext == null) return `Rank ${row.rankUB}`
    return `Ahead of the next row in ${Math.round(row.beatsNext * 1000) / 10}% of bootstrap replicates`
  }

  /**
   * The rating cell: a dot for the estimate, a whisker for the interval, a hairline
   * at the table mean, then the number and its half-width.
   *
   * A dot and a whisker rather than a bar, because a bar encodes a ratio to the
   * baseline it grows from and this scale has no such baseline — only differences
   * are identified, so a bar length here would encode nothing.
   *
   * @param {object} row
   * @param {[number, number]} domain shared across the table so rows are comparable
   * @returns {HTMLElement}
   */
  function ratingCell(row, domain) {
    const [lo, hi] = domain
    const span = (hi - lo) || 1
    const pct = v => ((v - lo) / span) * 100

    const track = el('div', { class: 'interval' })

    const anchorPct = pct(ELO_ANCHOR)
    if (anchorPct >= 0 && anchorPct <= 100) {
      track.appendChild(el('div', { class: 'anchor', style: `left:${anchorPct}%` }))
    }

    if (row.eloLow != null && row.eloHigh != null) {
      const width = Math.max(pct(row.eloHigh) - pct(row.eloLow), 0.5)
      track.appendChild(el('div', {
        class: 'whisker',
        style: `left:${pct(row.eloLow)}%;width:${width}%`,
      }))
    }

    track.appendChild(el('div', { class: 'dot', style: `left:${pct(row.elo)}%` }))

    return el('div', { class: 'rating' }, [
      track,
      el('span', { class: 'rating-value', text: String(Math.round(row.elo)) }),
      el('span', {
        class: 'rating-pm',
        text: row.eloLow != null ? `±${Math.round((row.eloHigh - row.eloLow) / 2)}` : '',
      }),
    ])
  }

  /**
   * The every-dimension matrix: one row per setup, ordered by the overall rating,
   * with each dimension's own independently fitted rating beside it.
   *
   * @param {object} ranking
   * @returns {HTMLElement}
   */
  function renderMatrixTable(ranking) {
    const overallRows = ranking.overall ?? []
    if (overallRows.length === 0) return el('div', { class: 'empty', text: 'No data yet.' })

    const dimRatings = {}
    for (const d of DIMENSIONS) {
      for (const row of ranking[d] ?? []) {
        dimRatings[row.id] ??= {}
        dimRatings[row.id][d] = row.elo
      }
    }

    const head = el('tr', null, [
      el('th', { class: 'col-rank', text: '#' }),
      el('th', { text: 'Setup' }),
      el('th', { class: 'num', text: 'Overall' }),
      ...DIMENSIONS.map(d => el('th', { class: 'num', text: DIM_LABELS[d] })),
    ])

    const body = overallRows.map((row, i) => el('tr', null, [
      el('td', {
        class: i === 0 ? 'rank rank-top' : 'rank',
        title: rankTitle(row),
        text: String(i + 1),
      }),
      el('td', null, [el('div', { class: 'setup', title: row.id, text: row.id })]),
      el('td', { class: 'num accent', text: String(Math.round(row.elo)) }),
      ...DIMENSIONS.map(d => {
        const r = dimRatings[row.id]?.[d]
        return el('td', {
          class: r == null ? 'num faint' : 'num',
          text: r != null ? String(Math.round(r)) : '—',
        })
      }),
    ]))

    return el('div', { class: 'scroll' }, [
      el('table', { class: 'bt matrix' }, [
        el('thead', null, [head]),
        el('tbody', null, body),
      ]),
    ])
  }

  /**
   * One Bradley-Terry table.
   *
   * The doubt in a ranking lives in the step between two neighbours, so that is
   * where it is drawn: a solid rule under a row is a step the comparisons
   * establish, a dashed one is a step they do not.
   *
   * @param {object} ranking
   * @param {string} dim 'all' for the matrix, otherwise 'overall' or one dimension
   * @returns {HTMLElement}
   */
  function renderRankingTable(ranking, dim) {
    if (dim === 'all') return renderMatrixTable(ranking)

    const rows = ranking[dim] ?? []
    if (rows.length === 0) return el('div', { class: 'empty', text: 'No data yet.' })

    // One domain for the whole table, padded so the outermost interval ends do not
    // sit flush against the column edge.
    const lows = rows.map(r => r.eloLow ?? r.elo)
    const highs = rows.map(r => r.eloHigh ?? r.elo)
    const min = Math.min(...lows, ELO_ANCHOR)
    const max = Math.max(...highs, ELO_ANCHOR)
    const pad = ((max - min) || 1) * 0.06
    const domain = [min - pad, max + pad]

    const head = el('tr', null, [
      el('th', {
        class: 'col-rank',
        title: 'Position by rating. An ordinal only: a dashed rule under a row marks a step to the row below that the run has not established at 95%.',
        text: '#',
      }),
      el('th', { text: 'Setup' }),
      el('th', { class: 'col-rating', text: 'Rating (95% CI)' }),
      el('th', { class: 'col-n', text: 'W' }),
      el('th', { class: 'col-n', text: 'L' }),
      el('th', { class: 'col-n', text: 'T' }),
      el('th', { class: 'col-n', text: 'N' }),
    ])

    const body = rows.map((row, i) => {
      const firm = row.beatsNext == null || row.beatsNext >= STEP_FIRM
      const ratingTitle = row.eloLow != null
        ? `${Math.round(row.elo)} (95% CI ${Math.round(row.eloLow)}–${Math.round(row.eloHigh)}) over ${row.comparisons} comparisons`
        : `${Math.round(row.elo)} over ${row.comparisons} comparisons`

      return el('tr', { class: firm ? null : 'soft-step' }, [
        el('td', {
          class: i === 0 ? 'rank rank-top' : 'rank',
          title: rankTitle(row),
          text: String(i + 1),
        }),
        el('td', null, [el('div', { class: 'setup', title: row.id, text: row.id })]),
        el('td', { title: ratingTitle }, [ratingCell(row, domain)]),
        el('td', { class: 'wins', text: String(row.wins) }),
        el('td', { class: 'losses', text: String(row.losses) }),
        el('td', { class: 'ties', text: String(row.ties) }),
        el('td', { class: 'faint', text: String(row.comparisons) }),
      ])
    })

    return el('table', { class: 'bt' }, [
      el('thead', null, [head]),
      el('tbody', null, body),
    ])
  }

  // ── Pair results ────────────────────────────────────────────────────────────

  /**
   * Order-independent key for a setup pair, so the two dropdowns find a record
   * whichever way round the user picked the setups.
   *
   * @param {string} a
   * @param {string} b
   * @returns {string}
   */
  const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`)

  /**
   * Index the selected source's records by setup pair.
   *
   * @returns {Map<string, Array>} keyed by pairKey
   */
  function recordsByPair() {
    const byPair = new Map()
    for (const r of currentRecords()) {
      const key = pairKey(r.setupA, r.setupB)
      if (!byPair.has(key)) byPair.set(key, [])
      byPair.get(key).push(r)
    }
    return byPair
  }

  /**
   * Which setups have at least one comparison against `setup` in this source.
   * Drives the second dropdown so it can only offer pairs that exist.
   *
   * @param {string} setup
   * @returns {string[]} sorted
   */
  function partnersOf(setup) {
    const partners = new Set()
    for (const r of currentRecords()) {
      if (r.setupA === setup) partners.add(r.setupB)
      else if (r.setupB === setup) partners.add(r.setupA)
    }
    return [...partners].sort()
  }

  /**
   * Subject first, then figure with numeric-aware ordering so `5.2.6` sorts
   * before `11.3` rather than after it.
   *
   * @param {object} x
   * @param {object} y
   * @returns {number}
   */
  function compareFigures(x, y) {
    const sx = x.subject ?? ''
    const sy = y.subject ?? ''
    if (sx !== sy) return sx < sy ? -1 : 1
    return String(x.figure ?? '').localeCompare(String(y.figure ?? ''), undefined, { numeric: true })
  }

  /**
   * 'A', 'B' or 'Tie' for a winner, relative to the *user's* chosen orientation.
   *
   * Records store their pair in canonical order, which is not necessarily the
   * order the dropdowns are in, so this resolves against pairA/pairB rather than
   * against the record's own setupA/setupB.
   *
   * @param {string|undefined} winner
   * @param {string} a
   * @param {string} b
   * @returns {{label: string, cls: string}|null} null when there is no verdict
   */
  function sideOf(winner, a, b) {
    if (!winner) return null
    if (winner === 'tie') return { label: 'Tie', cls: 'badge badge-tie' }
    if (winner === a) return { label: 'A', cls: 'badge badge-a' }
    if (winner === b) return { label: 'B', cls: 'badge badge-b' }
    return { label: winner, cls: 'badge badge-tie' }
  }

  /**
   * A winner badge, or a dash when the verdict is missing.
   *
   * @param {string|undefined} winner
   * @param {string} a
   * @param {string} b
   * @param {string} [title] hover text, typically the judge's rationale
   * @returns {HTMLElement}
   */
  function winnerCell(winner, a, b, title) {
    const side = sideOf(winner, a, b)
    if (!side) return el('td', { class: 'muted', text: '—' })
    return el('td', null, [el('span', { class: side.cls, title, text: side.label })])
  }

  /**
   * Count how each side did over a set of records under one winner accessor.
   *
   * @param {Array} records
   * @param {(record: object) => string|undefined} winnerOf
   * @param {string} a
   * @param {string} b
   * @returns {{a: number, b: number, tie: number, n: number}}
   */
  function tally(records, winnerOf, a, b) {
    const count = { a: 0, b: 0, tie: 0, n: 0 }
    for (const r of records) {
      const w = winnerOf(r)
      if (w === a) count.a++
      else if (w === b) count.b++
      else if (w === 'tie') count.tie++
      else continue
      count.n++
    }
    return count
  }

  /**
   * The tally strip above the pair table. Each item carries its own label so it
   * still reads correctly out of the context of the column it summarises.
   *
   * @param {Array<{label: string, text?: string, a?: number, b?: number, tie?: number, n?: number}>} items
   * @returns {HTMLElement}
   */
  function renderSummary(items) {
    return el('div', { class: 'summary' }, items.map(item => {
      const counts = el('span', { class: 'summary-counts' })

      if (item.text != null) {
        counts.textContent = item.text
      } else if (item.n === 0) {
        counts.appendChild(el('span', { class: 'muted', text: '—' }))
      } else {
        counts.appendChild(el('span', { style: 'color:var(--badge-a-text)', text: `A:${item.a}` }))
        counts.appendChild(document.createTextNode(' · '))
        counts.appendChild(el('span', { style: 'color:var(--badge-b-text)', text: `B:${item.b}` }))
        if (item.tie > 0) {
          counts.appendChild(document.createTextNode(' · '))
          counts.appendChild(el('span', { style: 'color:var(--badge-tie-text)', text: `T:${item.tie}` }))
        }
      }

      return el('div', { class: 'summary-item' }, [
        el('span', { class: 'summary-label', text: item.label }),
        counts,
      ])
    }))
  }

  /**
   * Per-figure verdicts for one pair under a machine judge: each dimension's
   * winner, the aggregator's, and its confidence. Rationales hang off the badges
   * as tooltips.
   *
   * @param {Array} records
   * @param {string} a
   * @param {string} b
   * @returns {DocumentFragment}
   */
  function renderMachinePairTable(records, a, b) {
    const frag = document.createDocumentFragment()

    frag.appendChild(renderSummary([
      { label: 'Comparisons', text: String(records.length) },
      ...DIMENSIONS.map(d => ({
        label: DIM_LABELS[d],
        ...tally(records, r => r.machineEval?.dimensions?.[d]?.winner, a, b),
      })),
      { label: 'Overall', ...tally(records, r => r.machineEval?.aggregator?.winner, a, b) },
    ]))

    const head = el('tr', null, [
      el('th', { class: 'col-figure', text: 'Figure' }),
      ...DIMENSIONS.map(d => el('th', { text: DIM_LABELS[d] })),
      el('th', { text: 'Overall' }),
      el('th', { class: 'col-n', text: 'Conf' }),
    ])

    const body = records.map(r => {
      const me = r.machineEval
      const confidence = me?.aggregator?.confidence

      return el('tr', null, [
        el('td', null, [
          el('div', { class: 'figure-name', text: String(r.figure ?? '—') }),
          el('div', { class: 'figure-subject', text: String(r.subject ?? '') }),
        ]),
        ...DIMENSIONS.map(d => winnerCell(
          me?.dimensions?.[d]?.winner, a, b, me?.dimensions?.[d]?.rationale,
        )),
        winnerCell(me?.aggregator?.winner, a, b, me?.aggregator?.explanation),
        el('td', {
          class: confidence == null ? 'muted' : null,
          text: confidence == null ? '—' : `${Math.round(confidence * 100)}%`,
        }),
      ])
    })

    frag.appendChild(el('div', { class: 'scroll' }, [
      el('table', { class: 'bt pair' }, [
        el('thead', null, [head]),
        el('tbody', null, body),
      ]),
    ]))
    return frag
  }

  /**
   * Per-figure verdicts for one pair under the humans: a single winner and
   * whatever note the judge left.
   *
   * @param {Array} records
   * @param {string} a
   * @param {string} b
   * @returns {DocumentFragment}
   */
  function renderHumanPairTable(records, a, b) {
    const frag = document.createDocumentFragment()
    const judged = records.filter(r => (r.humanEvals ?? []).length > 0)

    frag.appendChild(renderSummary([
      { label: 'Judged', text: `${judged.length} / ${records.length}` },
      { label: 'Winner', ...tally(records, r => r.humanEvals?.[0]?.winner, a, b) },
    ]))

    const head = el('tr', null, [
      el('th', { class: 'col-figure', text: 'Figure' }),
      el('th', { class: 'col-n', text: 'Winner' }),
      el('th', { text: 'Notes' }),
    ])

    const body = records.map(r => {
      const he = r.humanEvals?.[0]
      return el('tr', null, [
        el('td', null, [
          el('div', { class: 'figure-name', text: String(r.figure ?? '—') }),
          el('div', { class: 'figure-subject', text: String(r.subject ?? '') }),
        ]),
        winnerCell(he?.winner, a, b),
        el('td', null, [el('div', { class: 'notes', title: he?.notes ?? '', text: he?.notes ?? '' })]),
      ])
    })

    frag.appendChild(el('table', { class: 'bt pair' }, [
      el('thead', null, [head]),
      el('tbody', null, body),
    ]))
    return frag
  }

  /**
   * The pair panel: two dropdowns and, once both are set, the per-figure verdicts
   * behind that pair.
   *
   * It follows the source toggle rather than carrying its own, because the judge
   * whose ranking is on screen is the judge whose individual verdicts you would
   * want to inspect. A pair with no records under the current source says so
   * instead of rendering an empty table.
   */
  function renderPairPanel() {
    const src = activeSource()
    $('pair-source').textContent = src.label

    const controls = $('pair-controls')
    const body = $('pair-body')
    controls.innerHTML = ''
    body.innerHTML = ''

    const setups = [...new Set(currentRecords().flatMap(r => [r.setupA, r.setupB]))].sort()
    if (setups.length === 0) {
      body.appendChild(el('div', {
        class: 'empty',
        text: src.kind === 'human'
          ? 'No human evaluations in human/ yet.'
          : `No results found in ${src.dir}/.`,
      }))
      return
    }

    if (!setups.includes(state.pairA)) state.pairA = setups[0]
    const partners = partnersOf(state.pairA)
    if (!partners.includes(state.pairB)) state.pairB = partners[0] ?? ''

    const select = (value, options, onChange) => {
      const node = el('select', {
        onchange: e => { onChange(e.target.value); renderPairPanel() },
      }, options.map(o => el('option', { value: o, text: o })))
      node.value = value
      return node
    }

    controls.appendChild(el('div', { class: 'pair-picker' }, [
      el('label', null, ['Setup A', select(state.pairA, setups, v => { state.pairA = v })]),
      el('label', null, ['Setup B', select(state.pairB, partners, v => { state.pairB = v })]),
      el('button', {
        class: 'swap',
        type: 'button',
        title: 'Swap which setup is A and which is B',
        text: '⇄ Swap',
        onclick: () => {
          const { pairA, pairB } = state
          state.pairA = pairB
          state.pairB = pairA
          renderPairPanel()
        },
      }),
    ]))

    if (!state.pairB) {
      body.appendChild(el('div', { class: 'empty', text: `No comparisons against ${state.pairA} under ${src.label}.` }))
      return
    }

    const records = [...(recordsByPair().get(pairKey(state.pairA, state.pairB)) ?? [])]
      .sort(compareFigures)

    if (records.length === 0) {
      body.appendChild(el('div', { class: 'empty', text: `No comparisons for this pair under ${src.label}.` }))
      return
    }

    body.appendChild(src.kind === 'human'
      ? renderHumanPairTable(records, state.pairA, state.pairB)
      : renderMachinePairTable(records, state.pairA, state.pairB))
  }

  /**
   * Rebuild the control panel: setup checkboxes, then the layer, source and
   * dimension toggle groups. Rebuilt wholesale on every change, which keeps the
   * controls a pure function of state.
   */
  function renderControls() {
    const host = $('controls')
    host.innerHTML = ''

    const allSelected = selection().length === state.available.length
    const setupBox = el('div', { class: 'field' }, [
      el('div', { class: 'field-head' }, [
        el('span', { class: 'field-label', text: 'Setups' }),
        el('button', {
          class: 'link',
          text: allSelected ? 'Deselect all' : 'Select all',
          onclick: () => {
            state.selected = allSelected ? [] : [...state.available]
            render()
          },
        }),
      ]),
    ])

    const checks = el('div', { class: 'checks' })
    for (const s of state.available) {
      const checked = selection().includes(s)
      const input = el('input', { type: 'checkbox' })
      input.checked = checked
      input.addEventListener('change', () => {
        const current = [...selection()]
        state.selected = checked ? current.filter(x => x !== s) : [...current, s]
        render()
      })
      checks.appendChild(el('label', { class: 'check' }, [input, s]))
    }
    setupBox.appendChild(checks)
    host.appendChild(setupBox)

    const layerGroup = el('div', { class: 'group' }, LAYERS.map(l => el('button', {
      class: state.layer === l ? 'toggle on' : 'toggle',
      title: LAYER_TITLES[l],
      text: LAYER_LABELS[l],
      onclick: () => { state.layer = l; render() },
    })))

    const sourceGroup = el('div', { class: 'group' }, SOURCES.map(src => {
      const count = state.counts[src.dir] ?? 0
      return el('button', {
        class: `toggle${state.source === src.dir ? ' on' : ''}${count === 0 ? ' dim' : ''}`,
        title: `${count} records in ${src.dir}/`,
        text: src.label,
        onclick: () => {
          state.source = src.dir
          if (src.kind === 'human') state.dim = 'overall'
          render()
        },
      })
    }))

    // Dimensions do not exist for human verdicts, which are a single choice.
    const isHuman = activeSource().kind === 'human'
    const dimGroup = el('div', { class: 'group' }, ['overall', ...DIMENSIONS, 'all'].map(d => {
      const label = d === 'overall' ? 'Overall' : d === 'all' ? 'All Scores' : DIM_LABELS[d]
      const disabled = d !== 'overall' && isHuman
      const btn = el('button', {
        class: `toggle small${state.dim === d ? ' on' : ''}`,
        title: disabled ? 'Human verdicts are a single choice, with no per-dimension ranking' : '',
        text: label,
        onclick: () => { if (!disabled) { state.dim = d; render() } },
      })
      btn.disabled = disabled
      return btn
    }))

    host.appendChild(el('div', { class: 'toggles' }, [layerGroup, sourceGroup, dimGroup]))
  }

  /** Fit and draw the tables for the current source, layer, dimension and selection. */
  function renderTables() {
    const host = $('tables')
    host.innerHTML = ''

    const src = activeSource()
    const records = currentRecords()

    if (records.length === 0) {
      host.appendChild(el('div', {
        class: 'empty',
        text: src.kind === 'human'
          ? 'No human evaluations in human/ yet.'
          : `No results found in ${src.dir}/.`,
      }))
      return
    }

    const dim = src.kind === 'human' ? 'overall' : state.dim
    const { groups } = buildRankings(records, state.selected, { layer: state.layer, source: src.kind })

    if (!groups.some(g => (g.ranking.overall ?? []).length > 0)) {
      host.appendChild(el('div', {
        class: 'empty',
        text: state.layer === 'ablation'
          ? 'No ablation comparisons for this source.'
          : 'No comparisons match the current selection.',
      }))
      return
    }

    // The reason the split exists, said once rather than once per table.
    if (groups.length > 1) {
      host.appendChild(el('p', {
        class: 'note',
        text: 'One table per experiment model. Layer A never puts two models against each other, so scores are comparable within a table and not across them.',
      }))
    }

    for (const g of groups) {
      const block = el('div', { class: 'group-block' })
      if (g.label) {
        const header = el('div', { class: 'group-label' }, [el('span', { text: g.label })])
        if (!g.connected) {
          header.appendChild(el('span', {
            class: 'warn',
            title: "This model's comparisons form more than one disconnected group, so its scores are not all on one scale.",
            text: 'incomplete',
          }))
        }
        block.appendChild(header)
      }
      block.appendChild(renderRankingTable(g.ranking, dim))
      host.appendChild(block)
    }
  }

  /**
   * Redraw everything.
   *
   * The fit runs for hundreds of milliseconds and blocks the main thread, so the
   * placeholder is painted first and the work deferred two frames — one to flush
   * the DOM write, one to let the browser actually paint it.
   */
  function render() {
    refreshAvailable()
    renderControls()
    $('tables').innerHTML = '<div class="empty">Computing…</div>'

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const t0 = performance.now()
      renderTables()
      const ms = Math.round(performance.now() - t0)
      renderPairPanel()
      const total = Object.values(state.counts).reduce((a, n) => a + n, 0)
      setStatus(`${total} records loaded · fitted in ${ms} ms`, 'ok')
    }))
  }

  // ── Screens ─────────────────────────────────────────────────────────────────

  /** Show the folder chooser, with an optional explanation of why. */
  function showPicker(message) {
    $('picker').style.display = ''
    $('panel').style.display = 'none'
    $('picker-note').textContent = message ?? ''
  }

  /** Show the rankings, hiding the chooser. */
  function showPanel() {
    $('picker').style.display = 'none'
    $('panel').style.display = ''
  }

  /**
   * Common tail for both load paths: fall back to the picker on an empty load,
   * otherwise select the first source that actually has records and draw.
   *
   * @param {boolean} ok whether anything was loaded
   */
  function afterLoad(ok) {
    if (!ok) {
      showPicker('No result files found there. Choose the figure-bench folder itself, or one judge folder such as gemini.')
      setStatus('')
      return
    }

    const withData = SOURCES.find(s => (state.counts[s.dir] ?? 0) > 0)
    if (withData) state.source = withData.dir
    showPanel()
    render()
  }

  /** @param {Error} err */
  const fail = err => setStatus(`Could not read that folder: ${err.message}`, 'error')

  /** Wire the folder button, the hidden directory input, and folder drag-and-drop. */
  function wirePicker() {
    const input = $('folder-input')
    $('pick-btn').addEventListener('click', () => input.click())
    input.addEventListener('change', () => {
      setStatus('Reading results…')
      loadFromFileList(input.files).then(afterLoad).catch(fail)
    })

    const zone = $('picker')
    for (const evt of ['dragenter', 'dragover']) {
      zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('hot') })
    }
    for (const evt of ['dragleave', 'drop']) {
      zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('hot') })
    }
    zone.addEventListener('drop', e => {
      const items = e.dataTransfer?.items
      if (!items) return
      setStatus('Reading results…')
      collectDropped(items).then(loadFromFileList).then(afterLoad).catch(fail)
    })
  }

  /**
   * Pick a load path from how the page was opened.
   *
   * Served, the page finds the files itself and the table appears with no
   * interaction. Under file:// fetch is blocked, so the folder chooser is the only
   * way in — and it is also the fallback when a server will not list directories.
   */
  function init() {
    wirePicker()

    $('reload-btn').addEventListener('click', () => {
      if (!isServed()) return showPicker('Choose the figure-bench folder again to reload.')
      setStatus('Reloading…')
      loadOverHttp().then(afterLoad).catch(fail)
    })

    if (!isServed()) {
      showPicker('')
      setStatus('')
      return
    }

    setStatus('Looking for result files…')
    loadOverHttp().then(ok => {
      if (ok) return afterLoad(true)
      showPicker('This server does not list directory contents, so the page could not find the result files by itself. Choose the folder instead.')
      setStatus('')
    }).catch(() => {
      showPicker('Could not read the result folders over HTTP. Choose the folder instead.')
      setStatus('')
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
