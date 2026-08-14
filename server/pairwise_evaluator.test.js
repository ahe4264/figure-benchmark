/**
 * pairwise_evaluator.test.js — agent response parsing.
 *
 * Every case here is one that actually cost a comparison in a real 600-comparison
 * run. A parse failure throws away six model calls and leaves a hole in the
 * design, so the parser is worth pinning down.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import path from 'node:path'

import { parseAgentJson, CONCEPT_BRIEF_SECTIONS, INTERACTIVITY_BRIEF_SECTIONS } from './pairwise_evaluator.js'
import { figureBriefLines, numberedBriefFor, PUBLIC_DIR } from './contexts.js'

const VERDICT = { winner: '1', confidence: 0.9, rationale: 'Figure 1 has cleaner labels.' }

test('bare JSON, the common case', () => {
  assert.deepEqual(parseAgentJson(JSON.stringify(VERDICT)), VERDICT)
})

test('a ```json fence', () => {
  assert.deepEqual(parseAgentJson('```json\n' + JSON.stringify(VERDICT) + '\n```'), VERDICT)
})

test('a ```javascript fence — 4 of the 8 real failures', () => {
  assert.deepEqual(parseAgentJson('```javascript\n' + JSON.stringify(VERDICT) + '\n```'), VERDICT)
})

test('a ```html fence', () => {
  assert.deepEqual(parseAgentJson('```html\n' + JSON.stringify(VERDICT) + '\n```'), VERDICT)
})

test('an unlabelled fence', () => {
  assert.deepEqual(parseAgentJson('```\n' + JSON.stringify(VERDICT) + '\n```'), VERDICT)
})

test('prose wrapped around the object', () => {
  const raw = `Here is my judgement:\n${JSON.stringify(VERDICT)}\nLet me know if you need more.`
  assert.deepEqual(parseAgentJson(raw), VERDICT)
})

test('an unescaped LaTeX backslash is repaired', () => {
  // The real "Bad escaped character" failure: \a is not a JSON escape, so an
  // undoubled \alpha kills the whole response. (Note \theta would have survived
  // by accident — \t is a legal escape — silently becoming a tab plus "heta".)
  const raw = '{"winner":"2","confidence":0.8,"rationale":"Figure 2 labels \\alpha and \\( x \\) correctly."}'
  const parsed = parseAgentJson(raw)
  assert.equal(parsed.winner, '2')
  assert.match(parsed.rationale, /\\alpha/)
})

test('valid escapes are left alone', () => {
  const raw = '{"winner":"1","confidence":0.5,"rationale":"Line one.\\nLine \\"two\\"."}'
  const parsed = parseAgentJson(raw)
  assert.equal(parsed.rationale, 'Line one.\nLine "two".')
})

test('a truncated response says so instead of reporting a syntax error', () => {
  const raw = '{"winner":"1","confidence":0.9,"rationale":"Figure 1 is better because it'
  assert.throws(() => parseAgentJson(raw), /truncated/)
})

test('an empty response is named as such', () => {
  assert.throws(() => parseAgentJson(''), /empty response/)
  assert.throws(() => parseAgentJson(null), /empty response/)
})

test('genuinely unparseable input still throws', () => {
  assert.throws(() => parseAgentJson('I cannot answer that.'))
})

// ── Brief slicing ──────────────────────────────────────────────────────────────
// The two grounded dimensions must not read the same specification. When concept
// was given the interactions list it stopped judging subject-matter truth and
// started grading interaction compliance, duplicating the interactivity agent's
// verdict — see CONCEPT_BRIEF_SECTIONS. These pin the separation in place, since
// nothing in a prompt can enforce it.

const lineNumbersOf = numbered =>
  numbered.split('\n').filter(Boolean).map(l => Number(l.slice(1, 6)))

/** Every stem whose brief actually has an interactions section to withhold. */
const groundedStems = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, 'contexts_export.json'), 'utf-8'),
)
  .map(c => String(c.figure_id))
  .filter(stem => figureBriefLines(stem).some(l => l.section === 'interactions'))

test('there are briefs to check', () => {
  assert.ok(groundedStems.length > 0, 'no context row carries an interactions section')
})

test('concept never sees an interactions line', () => {
  for (const stem of groundedStems) {
    const withheld = new Set(
      figureBriefLines(stem)
        .map((l, i) => ({ ...l, n: i + 1 }))
        .filter(l => l.section === 'interactions')
        .map(l => l.n),
    )
    for (const n of lineNumbersOf(numberedBriefFor(stem, CONCEPT_BRIEF_SECTIONS))) {
      assert.ok(!withheld.has(n), `${stem}: concept was given interactions line L${n}`)
    }
  }
})

test('the two grounded dimensions do not share a specification', () => {
  for (const stem of groundedStems) {
    const concept = new Set(lineNumbersOf(numberedBriefFor(stem, CONCEPT_BRIEF_SECTIONS)))
    const overlap = lineNumbersOf(numberedBriefFor(stem, INTERACTIVITY_BRIEF_SECTIONS))
      .filter(n => concept.has(n))
    // `identity` and `prompt` are shared on purpose: both dimensions need to know
    // which figure this is, and interaction correctness cannot read the
    // interactions text without the authored brief that defines its "panel (a)"
    // and "the kth rectangle". What must not be shared is either dimension's own
    // standard — `interactions` for one, `context` for the other.
    const sectionOf = new Map(
      figureBriefLines(stem).map((l, i) => [i + 1, l.section]),
    )
    for (const n of overlap) {
      const section = sectionOf.get(n)
      assert.ok(
        section === 'identity' || section === 'prompt',
        `${stem}: L${n} is in both briefs but belongs to "${section}"`,
      )
    }
  }
})

test('interaction correctness never sees the textbook context', () => {
  for (const stem of groundedStems) {
    const withheld = new Set(
      figureBriefLines(stem)
        .map((l, i) => ({ ...l, n: i + 1 }))
        .filter(l => l.section === 'context')
        .map(l => l.n),
    )
    for (const n of lineNumbersOf(numberedBriefFor(stem, INTERACTIVITY_BRIEF_SECTIONS))) {
      assert.ok(!withheld.has(n), `${stem}: interactivity was given context line L${n}`)
    }
  }
})
test('a slice keeps the line numbers it has in the whole brief', () => {
  for (const stem of groundedStems) {
    const full = figureBriefLines(stem)
    for (const line of numberedBriefFor(stem, CONCEPT_BRIEF_SECTIONS).split('\n').filter(Boolean)) {
      const n = Number(line.slice(1, 6))
      assert.equal(line.slice(8), full[n - 1].text, `${stem}: L${n} does not match the full brief`)
    }
  }
})

// ── Where verdicts are stored ─────────────────────────────────────────────────
//
// A round trip through the real directories, on a setup pair that exists only
// here. Everything written is removed again in the after() hook below, and the
// last assertions check that it was.

import {
  loadPairwiseResult, savePairwiseResult, loadAllPairwiseResults, loadAllPairsForRanking,
  loadHumanResult, saveHumanResult, loadAllHumanResults, clearMachineEval,
} from './pairwise_evaluator.js'
import { resultsDirFor, HUMAN_RESULTS_DIR, DEFAULT_JUDGE } from './judges.js'
import { pairKey } from '../src/lib/pairs.js'

const A = 'zzTest-alpha_SELFTEST'
const B = 'zzTest-beta_SELFTEST'
const SUBJECT = 'physics'
const FIGURE = 'zz-selftest-01'
const PAIR_FILE = `${pairKey(A, B)}.json`

const MACHINE = { aggregator: { winner: A, confidence: 0.8, explanation: 'x' }, dimensions: {} }
const HUMAN = [{ winner: B, notes: '', submittedAt: '2026-01-01T00:00:00.000Z' }]

const testFiles = () => [
  path.join(resultsDirFor(DEFAULT_JUDGE), PAIR_FILE),
  path.join(resultsDirFor('gpt-5.5'), PAIR_FILE),
  path.join(HUMAN_RESULTS_DIR, PAIR_FILE),
]

test.after(() => {
  for (const f of testFiles()) if (fs.existsSync(f)) fs.unlinkSync(f)
})

test('a judge writes into its own directory and nowhere else', () => {
  savePairwiseResult(A, B, SUBJECT, FIGURE, { setupA: A, setupB: B, subject: SUBJECT, figure: FIGURE, machineEval: MACHINE }, 'gpt-5.5')

  assert.ok(fs.existsSync(path.join(resultsDirFor('gpt-5.5'), PAIR_FILE)))
  assert.ok(!fs.existsSync(path.join(resultsDirFor(DEFAULT_JUDGE), PAIR_FILE)),
    'a gpt-5.5 run must not touch the default judge\u2019s results')
  assert.equal(loadPairwiseResult(A, B, SUBJECT, FIGURE, DEFAULT_JUDGE), null)
  assert.deepEqual(loadPairwiseResult(A, B, SUBJECT, FIGURE, 'gpt-5.5').machineEval, MACHINE)
})

test('a human verdict goes to the human directory, not a judge\u2019s', () => {
  saveHumanResult(A, B, SUBJECT, FIGURE, HUMAN)

  assert.ok(fs.existsSync(path.join(HUMAN_RESULTS_DIR, PAIR_FILE)))
  assert.deepEqual(loadHumanResult(A, B, SUBJECT, FIGURE).humanEvals, HUMAN)
  assert.deepEqual(loadAllHumanResults(A, B).map(r => r.figure), [FIGURE])

  // The judge's own file stays purely machine.
  const raw = JSON.parse(fs.readFileSync(path.join(resultsDirFor('gpt-5.5'), PAIR_FILE), 'utf-8'))
  assert.ok(!('humanEvals' in raw[`${SUBJECT}__${FIGURE}`]), 'humanEvals must not leak into a judge file')
})

/** The whole point of the split: one verdict, visible under every judge. */
test('the same human verdict is visible from every judge', () => {
  for (const judge of [DEFAULT_JUDGE, 'gpt-5.5']) {
    const merged = loadAllPairwiseResults(A, B, judge).find(r => r.figure === FIGURE)
    assert.deepEqual(merged.humanEvals, HUMAN, `human verdict missing under ${judge}`)
  }
})

test('the merged view carries each judge\u2019s own machine verdict', () => {
  const gpt = loadAllPairwiseResults(A, B, 'gpt-5.5').find(r => r.figure === FIGURE)
  const gemini = loadAllPairwiseResults(A, B, DEFAULT_JUDGE).find(r => r.figure === FIGURE)
  assert.deepEqual(gpt.machineEval, MACHINE)
  assert.equal(gemini.machineEval, null, 'gemini never evaluated this figure')
  assert.equal(gemini.setupA, A, 'a human-only record still knows its pair')
})

test('ranking records merge the judge and the human set', () => {
  const rows = loadAllPairsForRanking('gpt-5.5').filter(r => r.figure === FIGURE)
  assert.equal(rows.length, 1, 'a figure must appear once, not once per source')
  assert.deepEqual(rows[0].machineEval, MACHINE)
  assert.deepEqual(rows[0].humanEvals, HUMAN)
})

test('clearing a machine eval leaves the human verdict standing', () => {
  clearMachineEval(A, B, SUBJECT, FIGURE, 'gpt-5.5')
  const merged = loadAllPairwiseResults(A, B, 'gpt-5.5').find(r => r.figure === FIGURE)
  assert.equal(merged.machineEval, null)
  assert.deepEqual(merged.humanEvals, HUMAN)
})

test('the fixtures clean up after themselves', () => {
  // Runs last, and does the removal rather than merely checking it: the
  // file-level after() hook above is the safety net for an earlier failure.
  for (const f of testFiles()) if (fs.existsSync(f)) fs.unlinkSync(f)
  for (const f of testFiles()) assert.ok(!fs.existsSync(f), `left behind: ${f}`)
})
