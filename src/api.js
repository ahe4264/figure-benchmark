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

/** @returns {Promise<Array>} stored records for one pair. */
export async function fetchResults(setupA, setupB) {
  if (READ_ONLY) {
    // The exported file is the raw pair dict, keyed <subject>__<figure>.
    const dict = await getJson(`${STATIC_ROOT}/results/${pairKey(setupA, setupB)}.json`, {})
    return Object.values(dict)
  }
  const data = await getJson(
    `/api/pairwise/results/${encodeURIComponent(setupA)}/${encodeURIComponent(setupB)}`, [])
  return Array.isArray(data) ? data : []
}

/**
 * @param {string[]|null} selection restrict to comparisons between these setups
 * @returns {Promise<{machine, human, availableSetups}>}
 */
export async function fetchRankings(selection) {
  if (READ_ONLY) {
    const records = await getJson(`${STATIC_ROOT}/ranking-records.json`, [])
    return buildRankings(records, selection)
  }
  const qs = selection !== null ? '?setups=' + selection.map(encodeURIComponent).join(',') : ''
  return getJson('/api/pairwise/rankings' + qs, { machine: {}, human: {}, availableSetups: [] })
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

export function deleteMachineEval(setupA, setupB, subject, figure) {
  const seg = [setupA, setupB, subject, figure].filter(Boolean).map(encodeURIComponent).join('/')
  return send(`/api/pairwise/machine-eval/${seg}`, 'DELETE')
}
