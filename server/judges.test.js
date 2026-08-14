/**
 * judges.test.js — where each judge's verdicts are stored.
 *
 * The routing rule is duplicated nowhere: the evaluator, the API and the
 * schedule CLI all resolve through resultsDirFor(). These pin the properties the
 * whole scheme rests on — that every judge has a directory of its own, that no
 * two share one, and that none collides with the human result set. A regression
 * in any of those silently corrupts a finished run's results, or the ground
 * truth those results are measured against.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  JUDGES, DEFAULT_JUDGE, judgeFor, resultsDirFor, subdirFor, staticPrefixFor,
  RESULTS_ROOT, HUMAN_SUBDIR, HUMAN_RESULTS_DIR,
} from './judges.js'

test('the results root is benchmark_results/', () => {
  assert.equal(path.basename(RESULTS_ROOT), 'benchmark_results')
})

/**
 * No judge owns the root. The first one used to, back when it was the only
 * judge, and that left every reader carrying an "unless it is the default"
 * branch. The symmetric layout is what removes it.
 */
test('every judge lives in a subdirectory, none owns the root', () => {
  for (const id of Object.keys(JUDGES)) {
    assert.notEqual(resultsDirFor(id), RESULTS_ROOT, `judge "${id}" claims the results root`)
    assert.equal(path.dirname(resultsDirFor(id)), RESULTS_ROOT, `judge "${id}" is not a direct child`)
  }
})

test('gemini writes to benchmark_results/gemini/ and gpt-5.5 to benchmark_results/gpt5.5/', () => {
  assert.equal(resultsDirFor('gemini-3.1-pro'), path.join(RESULTS_ROOT, 'gemini'))
  assert.equal(resultsDirFor('gpt-5.5'), path.join(RESULTS_ROOT, 'gpt5.5'))
})

test('an omitted judge is the default judge', () => {
  for (const blank of [undefined, null, '']) {
    assert.equal(resultsDirFor(blank), resultsDirFor(DEFAULT_JUDGE))
  }
  assert.equal(judgeFor(undefined), JUDGES[DEFAULT_JUDGE])
})

/** Two judges sharing a directory is the exact failure this module prevents. */
test('no two judges share a directory', () => {
  const dirs = Object.keys(JUDGES).map(resultsDirFor)
  assert.equal(new Set(dirs).size, dirs.length, 'duplicate results directory')
})

test('every judge declares a non-empty, filename-safe subdir', () => {
  for (const [id, entry] of Object.entries(JUDGES)) {
    assert.ok(entry.resultsSubdir, `judge "${id}" has no resultsSubdir`)
    assert.match(entry.resultsSubdir, /^[A-Za-z0-9._-]+$/, `${id} has an awkward subdir`)
    assert.equal(subdirFor(id), entry.resultsSubdir)
  }
})

/**
 * A typo in --model must not quietly dump results into another judge's folder
 * and corrupt a finished run. Failing loudly is the whole point.
 */
test('an unknown judge throws rather than falling back', () => {
  assert.throws(() => resultsDirFor('gpt-5.5-turbo-ultra'), /unknown judge/i)
  assert.throws(() => judgeFor('nope'), /unknown judge/i)
})

// ── The registry has to agree with the model router ───────────────────────────

/**
 * A judge id is also a MODEL_REGISTRY key — that identity is what lets the
 * evaluating model decide, on its own, where its verdicts go. If the two lists
 * drifted, picking a judge in the UI would either fail at the first API call or
 * write somewhere nobody reads.
 */
test('every judge is a runnable model, and the default judge is the default model', async () => {
  const { MODEL_REGISTRY, DEFAULT_MODEL_ID } = await import('./models.js')
  for (const id of Object.keys(JUDGES)) {
    assert.ok(MODEL_REGISTRY[id], `judge "${id}" has no entry in MODEL_REGISTRY`)
  }
  assert.equal(DEFAULT_MODEL_ID, DEFAULT_JUDGE)
})

// ── Static-build paths ────────────────────────────────────────────────────────

test('a judge static prefix is its subdir plus a slash', () => {
  for (const id of Object.keys(JUDGES)) {
    assert.equal(staticPrefixFor(id), `${subdirFor(id)}/`)
  }
  assert.equal(staticPrefixFor('gemini-3.1-pro'), 'gemini/')
  assert.equal(staticPrefixFor(undefined), 'gemini/')
})

// ── The human set is nobody's judge folder ────────────────────────────────────

/**
 * If a judge ever claimed 'human' as its subdir, its machine verdicts and the
 * shared human verdicts would land in the same files and the ground truth would
 * be corrupted by the very thing it is supposed to measure.
 */
test('no judge may claim the human directory', () => {
  for (const [id, entry] of Object.entries(JUDGES)) {
    assert.notEqual(entry.resultsSubdir, HUMAN_SUBDIR, `judge "${id}" collides with the human result set`)
    assert.notEqual(resultsDirFor(id), HUMAN_RESULTS_DIR)
  }
})

test('the human directory sits beside the judges, inside benchmark_results', () => {
  assert.equal(HUMAN_RESULTS_DIR, path.join(RESULTS_ROOT, HUMAN_SUBDIR))
  assert.equal(path.dirname(HUMAN_RESULTS_DIR), RESULTS_ROOT)
})
