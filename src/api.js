/**
 * api.js — the benchmark tab's data layer, and the one place that knows whether
 * this build can write anything.
 *
 * The /api routes are registered by a Vite `configureServer` hook, which only
 * runs under `npm run dev`. A production build (Vercel, `npm run preview`) has
 * no server at all, so the build step exports the same data as static JSON under
 * /api-static and READ_ONLY flips every reader over to it. Writers — evaluation
 * runs, deletes, human submissions — have nowhere to go and are hidden from the
 * UI rather than left to fail on click.
 */

import { joinMatchingFigures, pairKey } from './lib/pairs.js'
import { buildRankings } from './lib/rankings.js'
import { availableJudges, rankingSources, rankingSourceFor, staticPrefixFor, HUMAN_STATIC_PREFIX } from './lib/judges.js'

/** True when there is no API behind this build: viewing works, running doesn't. */
export const READ_ONLY = !import.meta.env.DEV

const STATIC_ROOT = '/api-static'

async function getJson(url, fallback) {
  try {
    const res = await fetch(url)
    if (!res.ok) return fallback
    return await res.json()
  } catch {
    return fallback
  }
}

/** Cached because several callers need the full setup list per page load. */
let staticSetupsPromise = null
function staticSetups() {
  staticSetupsPromise ??= getJson(`${STATIC_ROOT}/setups.json`, { setups: [] })
  return staticSetupsPromise
}

// ── Readers ───────────────────────────────────────────────────────────────────

/** Evaluation models. Empty in read-only builds — nothing can be run. */
export async function fetchModels() {
  if (READ_ONLY) return []
  const models = await getJson('/api/models', [])
  return Array.isArray(models) ? models : []
}

/**
 * The judges that have a result set of their own.
 *
 * Unlike fetchModels this is *not* empty in a read-only build: a deployed site
 * cannot run an evaluation but can still browse either judge's finished results,
 * and the list is static data rather than a server capability.
 */
export async function fetchJudges() {
  if (READ_ONLY) return availableJudges()
  const judges = await getJson('/api/judges', [])
  return Array.isArray(judges) && judges.length ? judges : availableJudges()
}

/**
 * The judges a ranking can be built from — every machine judge, plus the humans.
 * A superset of fetchJudges: you can rank by human verdicts but cannot run an
 * evaluation with them.
 */
export async function fetchRankingSources() {
  if (READ_ONLY) return rankingSources()
  const sources = await getJson('/api/ranking-sources', [])
  return Array.isArray(sources) && sources.length ? sources : rankingSources()
}

/** @returns {Promise<Array<{id, figures}>>} every experiment and its figures. */
export async function fetchSetups() {
  const data = READ_ONLY ? await staticSetups() : await getJson('/api/setups', { setups: [] })
  return data.setups || []
}

/** @returns {Promise<Array>} figures present in both setups. */
export async function fetchMatchingFigures(setupA, setupB) {
  if (!setupA || !setupB || setupA === setupB) return []
  if (READ_ONLY) {
    const { setups } = await staticSetups()
    return joinMatchingFigures(setups || [], setupA, setupB)
  }
  const qs = `?setupA=${encodeURIComponent(setupA)}&setupB=${encodeURIComponent(setupB)}`
  const data = await getJson(`/api/pairwise/setups${qs}`, {})
  return data.matchingFigures || []
}

/** @returns {Promise<Array>} stored records for one pair, from one judge. */
export async function fetchResults(setupA, setupB, judge) {
  if (READ_ONLY) {
    // The exported file is the raw pair dict, keyed <subject>__<figure>. The
    // prefix is empty for the default judge, so its URLs are unchanged.
    const dict = await getJson(`${STATIC_ROOT}/results/${staticPrefixFor(judge)}${pairKey(setupA, setupB)}.json`, {})
    return Object.values(dict)
  }
  const qs = judge ? `?judge=${encodeURIComponent(judge)}` : ''
  const data = await getJson(
    `/api/pairwise/results/${encodeURIComponent(setupA)}/${encodeURIComponent(setupB)}${qs}`, [])
  return Array.isArray(data) ? data : []
}

/**
 * @param {string[]|null} selection restrict to comparisons between these setups
 * @param {object} [opts]
 * @param {string} [opts.judge] whose verdicts to rank — a machine judge id, or
 *   'human' for the shared human result set. Defaults to the default judge.
 * @param {'all'|'ablation'|'rotation'} [opts.layer] which layer of the design
 * @returns {Promise<{groups, availableSetups, layer, source}>}
 */
export async function fetchRankings(selection, { judge, layer = 'all' } = {}) {
  const empty = { groups: [], availableSetups: [], layer, source: 'machine' }
  if (READ_ONLY) {
    // buildRankings is the same function the server calls, so a deployed build
    // splits and filters itself rather than needing a table pre-computed per mode.
    const { id, kind } = rankingSourceFor(judge)
    const prefix = kind === 'human' ? HUMAN_STATIC_PREFIX : staticPrefixFor(id)
    const records = await getJson(`${STATIC_ROOT}/${prefix}ranking-records.json`, [])
    return buildRankings(records, selection, { layer, source: kind })
  }
  const params = new URLSearchParams()
  if (selection !== null) params.set('setups', selection.join(','))
  if (judge) params.set('judge', judge)
  if (layer && layer !== 'all') params.set('layer', layer)
  const qs = params.toString()
  return getJson('/api/pairwise/rankings' + (qs ? `?${qs}` : ''), empty)
}

/**
 * Human verdicts for one pair, without any judge's machine verdicts.
 *
 * The judging page only needs to know which figures are already done, and a
 * judge's rationales run to megabytes, so this is a separate read rather than a
 * filter over fetchResults.
 */
export async function fetchHumanResults(setupA, setupB) {
  if (!setupA || !setupB || setupA === setupB) return []
  if (READ_ONLY) {
    const dict = await getJson(`${STATIC_ROOT}/results/${HUMAN_STATIC_PREFIX}${pairKey(setupA, setupB)}.json`, {})
    return Object.values(dict)
  }
  const data = await getJson(
    `/api/pairwise/human-results/${encodeURIComponent(setupA)}/${encodeURIComponent(setupB)}`, [])
  return Array.isArray(data) ? data : []
}

/** Fetch a generated figure's markup, for the srcDoc-rendered comparison views. */
export async function fetchHtml(url) {
  if (!url) return null
  try {
    const res = await fetch(url)
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

// ── Writers (dev only) ────────────────────────────────────────────────────────

function assertWritable() {
  if (READ_ONLY) throw new Error('This is a read-only build — run the site locally to evaluate.')
}

async function send(url, method, body) {
  assertWritable()
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${url} failed (${res.status})`)
  return res
}

/** @returns the streaming NDJSON response; the caller reads it line by line. */
export function startBatchEvaluate(body) {
  return send('/api/pairwise/batch-evaluate', 'POST', body)
}

export function submitHumanEval(body) {
  return send('/api/pairwise/human-evaluate', 'POST', body)
}

export function clearHumanEval(body) {
  return send('/api/pairwise/human-evaluate', 'DELETE', body)
}

export function deleteMachineEval(setupA, setupB, subject, figure, judge) {
  const seg = [setupA, setupB, subject, figure].filter(Boolean).map(encodeURIComponent).join('/')
  const qs = judge ? `?judge=${encodeURIComponent(judge)}` : ''
  return send(`/api/pairwise/machine-eval/${seg}${qs}`, 'DELETE')
}
