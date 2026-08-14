/**
 * pairwise_evaluator.js — head-to-head comparison of two generated figures.
 *
 * Runs 5 parallel dimension agents then a single aggregator call.
 * Position assignment (Figure 1 vs Figure 2) is randomized once per figure,
 * then held fixed across all 5 dimension agents and the aggregator.
 *
 * Ported from visionbook/figure-platform/backend/pairwise_evaluator.js. The
 * comparison protocol is unchanged; what differs is that a setup is a single
 * experiment folder (not <experiment>/<model>), records are keyed by subject
 * rather than chapter, and the concept agent is grounded in a figure brief from
 * contexts_export.json rather than a textbook QMD — so its prompt asks it to
 * cite that brief by L-number instead of citing chapter lines.
 */

import fs from 'fs'
import path from 'path'
import { generateWithModel, DEFAULT_MODEL_ID } from './models.js'
import { numberLines, numberedBriefFor } from './contexts.js'
import { resultsDirFor, HUMAN_RESULTS_DIR } from './judges.js'
import { pairKey } from '../src/lib/pairs.js'

const PAIRWISE_DEFAULT_MODEL = DEFAULT_MODEL_ID
const PAIRWISE_MAX_TOKENS = 16384

// ── Position helpers ──────────────────────────────────────────────────────────
// pairKey lives in src/lib/pairs.js so the browser can derive the same result
// filenames from a static export (see the import at the top of this file).

/**
 * Fallback seating for callers that pass no `positions`.
 *
 * A coin flip balances the two slots only in expectation, which is why the batch
 * route supplies a counterbalanced assignment instead — see positionAssignments()
 * in src/lib/schedule.js. This remains for one-off calls that have no figure list
 * to counterbalance across.
 */
function randomizeOrder(setupA, setupB) {
  return Math.random() < 0.5
    ? { figure1: setupA, figure2: setupB }
    : { figure1: setupB, figure2: setupA }
}

/** A supplied seating has to name exactly the two setups being compared. */
function resolvePositions(positions, setupA, setupB) {
  if (!positions) return randomizeOrder(setupA, setupB)
  const { figure1, figure2 } = positions
  const named = [figure1, figure2].sort()
  const expected = [setupA, setupB].sort()
  if (named[0] !== expected[0] || named[1] !== expected[1]) {
    throw new Error(`positions names ${figure1}/${figure2}, expected ${setupA}/${setupB}`)
  }
  return { figure1, figure2 }
}

/**
 * Map an agent's verdict onto setup names.
 *
 * Anything that is not "1", "2", or "tie" throws rather than falling back. A
 * missing or malformed winner used to be recorded as a genuine tie, which fed
 * Bradley-Terry a draw that never happened; failing here surfaces it as an
 * evaluation error, which the batch handler already reports per figure.
 */
function resolveWinner(llmWinner, figure1, figure2, label = 'agent') {
  const verdict = String(llmWinner ?? '').trim().toLowerCase()
  if (verdict === '1') return figure1
  if (verdict === '2') return figure2
  if (verdict === 'tie') return 'tie'
  throw new Error(`${label} returned an unusable winner: ${JSON.stringify(llmWinner)} — expected "1", "2", or "tie".`)
}

/**
 * Escape lone backslashes that JSON does not permit.
 *
 * Rationales quote LaTeX — "\(", "\theta", "\frac" — and a judge that does not
 * double the backslash emits a response one character short of valid. Doubling
 * anything that is not already a legal escape recovers it without touching the
 * escapes that were written correctly.
 */
function repairJsonEscapes(text) {
  return text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
}

/**
 * Pull the JSON object out of an agent response.
 *
 * Judges are asked for bare JSON and mostly comply, but a small share wrap it in
 * a fence. Accepting only ```json — as this did originally — meant a ```javascript
 * or ```html tag was captured as part of the payload and the whole comparison was
 * thrown away on a parse error. Over one 600-comparison run that cost 5 of the 8
 * failures, so the parser now takes any language tag, tolerates surrounding prose,
 * and repairs the one malformed-escape case that shows up in practice.
 */
export function parseAgentJson(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new Error('agent returned an empty response')

  let content = text
  // Any language tag, or none. The tag is decoration; the body is the payload.
  const fenced = content.match(/```[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```/)
  if (fenced) content = fenced[1].trim()

  // Otherwise fall back to the outermost braces, for a response that opens with
  // a sentence of preamble before the object.
  if (!content.startsWith('{')) {
    const first = content.indexOf('{')
    const last = content.lastIndexOf('}')
    if (first >= 0 && last > first) content = content.slice(first, last + 1)
  }

  try {
    return JSON.parse(content)
  } catch (err) {
    const repaired = repairJsonEscapes(content)
    if (repaired !== content) {
      try { return JSON.parse(repaired) } catch { /* report the original failure */ }
    }
    // A response cut off mid-object is a token-budget problem, not a format one,
    // and saying so is the difference between a one-line fix and an investigation.
    if (!content.endsWith('}')) {
      throw new Error(`agent response looks truncated (${content.length} chars, no closing brace) — raise PAIRWISE_MAX_TOKENS if this recurs`)
    }
    throw err
  }
}

// ── Dimension agent prompts ────────────────────────────────────────────────────

const SHARED_PREAMBLE = `You are a strict evaluator comparing two Three.js 3D figure implementations (Figure 1 and Figure 2) of the same textbook figure.
Be critical and honest. Only call "tie" when both figures are indistinguishable on this dimension — default to picking the better one.
Your rationale must be comparative: explain specifically what the winner does better AND what the loser does worse — not just why the winner is good in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"rationale":"<at least one sentence comparing both figures; use more only if there is more to say>"}`

const SHARED_PREAMBLE_2D = `You are a strict evaluator comparing two inline-interactive 2D figure implementations (Figure 1 and Figure 2) of the same textbook figure.
Be critical and honest. Only call "tie" when both figures are identical or indistinguishable on this dimension — default to picking the better one.
Your rationale must be comparative: explain specifically what the winner does better AND what the loser does worse — not just why the winner is good in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"rationale":"<at least one sentence comparing both figures; use more only if there is more to say>"}`

const GEOMETRY_3D = `${SHARED_PREAMBLE}

DIMENSION: Geometric accuracy — which figure better reconstructs the 3D geometry of the original.
Evaluate: axis ranges, tick marks and gridlines, correct 3D shapes/primitives, spatial relationships, element counts, proportions, depth/perspective, and initial camera viewpoint matching the source.
Watch for: incorrect 3D perspective, wrong shapes for the concept, proportions noticeably off. Take special note of 2D canvases in 3D space - this automatically loses.
Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`

const GEOMETRY_2D = `${SHARED_PREAMBLE_2D}

DIMENSION: Structural accuracy — which figure better reconstructs the 2D structure of the original.
Evaluate: axis ranges, tick marks and gridlines, the shape and trend of the data, node-and-edge topology and counts, relative proportions and layout, and line styling (dashed vs solid, stroke weight, arrowheads, fill vs outline).
Watch for: the wrong mark type for the concept (a scatter drawn as a connected line, a bar chart drawn as an area, a directed edge missing its arrowhead), missing series or nodes, proportions noticeably off.
These are 2D figures: do NOT reward or penalise depth, perspective, or 3D vantage point.
Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`

const sharedDimensions = preamble => ({
  interactivity: `${preamble}

DIMENSION: Interaction correctness — whether a figure's controls work.
Evaluate: whether each handler recomputes and redraws what it claims to, whether its effect on the figure is the one the control advertises, whether the figure holds up at the extremes of every control and at degenerate inputs — and only then, carrying less weight, how much of the requested interaction list a figure covers.
Read the request as intent rather than wording to match: a different affordance that reaches the same state satisfies it, a symbolic label satisfies a request that a quantity be shown so long as the interaction itself updates correctly, and a line that is incoherent or contradicts the subject matter should be named as such and judged by what it evidently intends. Controls beyond the request are not faults — judge those on whether they work and whether they help.
Watch for: an effect that runs backwards, a handler computing the wrong quantity, a control that alters the user's input behind their back, a bad input silently swallowed so a stale figure stays on screen, a displayed value that disagrees with what is drawn, ranges that admit non-physical states or are narrowed so far the phenomenon the control exists to show cannot be reached.
View manipulation — orbit, pan, or zoom — is not developer-built and is out of scope here.
Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`,

  faithfulness: `${preamble}

DIMENSION: Visual faithfulness — which figure is more recognizable as the same figure as the original.
Judge overall resemblance at a glance — composition, geometry or data shape, colour scheme — not an exhaustive checklist of small differences. The bar is that a reader recognizes it as the same figure, NOT that it is a pixel-level replacement. A multipanel original may legitimately be shown one panel at a time behind a toggle or step control, so a panel absent from the screenshot is not on its own a fault.
Watch for: a colour scheme that reads as a different one, invented elements neither present in nor implied by the original, proportions or composition off enough to obscure what the figure shows.
You will receive the original textbook figure image, plus rendered screenshots of Figure 1 and Figure 2.`,

  labels: `${preamble}

DIMENSION: Label quality — which figure has better text labels and annotations matching the original.
Evaluate: presence of all required labels, correctness of label text, readability, size, placement, and freedom from clutter.
Nothing screens label placement automatically, so actively penalise labels that collide with each other or with the artwork, escape the plot or diagram area, are clipped at the edge, or are too small to read comfortably at inline size.
Watch for: important annotations absent, labels present in the original but missing from the generation, labels invented that the original does not have.
You will receive the original textbook figure image, plus rendered screenshots of Figure 1 and Figure 2.`,

  concept: `${preamble}

DIMENSION: Concept accuracy — which figure teaches the subject matter more correctly. Judge the truth of what the figure and its labels assert.
Evaluate: work out the 1-4 key concepts the figure should convey, anchoring each to the brief lines that establish it, then judge how truthfully each figure represents them — whether its geometry, labels, and annotations assert what is true, whether the relationships shown hold on the subject's own terms and not only for the case drawn, and whether a student reading it would come away with a correct understanding.
Whether a requested control is present, absent, or replaced is another dimension's question and not yours; a control concerns you only when what it computes, displays, or asserts is false.
Watch for: a wrong sign or direction, a wrong relationship or limiting behaviour, a mislabelled quantity or axis, a claim true only of the drawn instance, a quantity computed by a formula that does not match the one the brief states, statements that contradict the subject matter of the brief. The original figure is context, not ground truth — an error still counts when the original shares it.
You are given the caption, the textbook context, and the authored figure brief, every line prefixed with a line number (L00001:, L00002:, …); they are the standard you judge against. Cite the lines each judgement rests on as L-numbers in parentheses: a single line (L00031) or a range (L00012-L00014) — do not fault a figure for omitting something the brief never asks for, and do not credit a claim the brief does not support.
The figure brief is prose; Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`,
})

const PAIRWISE_MODES = {
  '3d': { geometry: GEOMETRY_3D, ...sharedDimensions(SHARED_PREAMBLE) },
  '2d': { geometry: GEOMETRY_2D, ...sharedDimensions(SHARED_PREAMBLE_2D) },
}

function resolvePromptSet(mode) {
  const key = String(mode || '3d').toLowerCase()
  if (!PAIRWISE_MODES[key]) {
    console.warn(`[pairwise] unknown mode "${mode}" — falling back to '3d'.`)
    return PAIRWISE_MODES['3d']
  }
  return PAIRWISE_MODES[key]
}

/**
 * The aggregator used to be told it was reading "five independent" agents. It is not.
 * Over one 9-figure run the dimensions fell into two blocks agreeing 78% internally and
 * only 44% across — below chance — and the split is exactly the modality split below:
 * the agents that see pixels versus the agents that see code. One property of a figure
 * that is visible in one view and not the other therefore arrives as two concurring
 * votes, and an aggregator told they were independent read that as corroboration.
 */
const AGGREGATOR_PROMPT = `You receive pairwise preferences from five dimension agents that each compared Figure 1 vs Figure 2.

The agents do not see the same evidence, and two pairs of them share a view:
- faithfulness and labels judge rendered screenshots only, with no access to source code.
- geometry, interactivity and concept judge the source code, with no access to any rendering.
- interactivity and concept each read one part of the authored brief, and the two parts are disjoint. Interactivity is given the list of intended interactions and asks mainly whether the controls that exist behave correctly, and only secondarily how much of that list is covered; concept is given the caption and textbook context and asks whether what the figure asserts is true. Neither sees the other's part, so they can disagree without either being wrong, and agreement between them is not corroboration of a single fault.
Synthesize a final judgment. Up-weight agents with higher confidence.
Only call "tie" if the dimension votes are split with no clear overall winner.
Your explanation must be comparative: cite specific strengths of the winner over the loser and specific weaknesses of the loser relative to the winner — not just a list of the winner's merits in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"explanation":"<two to three sentences comparing both figures>"}`

// ── Single dimension agent call ────────────────────────────────────────────────

/**
 * Dimensions that are judged against the authored brief rather than against the
 * reference image or the code alone.
 *
 * Interactivity belongs here even though it reads as a code-only dimension. Its
 * prompt asks whether a control does what it advertises — which, without the
 * brief, is a test of internal consistency and nothing more: a figure that
 * implements the requested interactions and one that invents an unrelated set
 * both pass, so long as each control matches its own label. The `interactions`
 * field states what was actually asked for, and withholding it made a whole class
 * of fault invisible.
 *
 * The prompt reads that field as intent rather than as wording to match, and
 * weighs whether the controls that exist work above how much of the list they
 * cover. Grading literal compliance turned a presentation habit into a sweep:
 * across the 100 figures two gemini setups share, one emits 153 formatted numeric
 * readouts to the other's 85, and a spec that says a value is "displayed" reads a
 * symbolic label as a missing feature even when the interaction behind it works.
 *
 * Geometry and faithfulness stay ungrounded on purpose: both are judged against
 * the reference figure, which is the right standard for them.
 */
const GROUNDED_DIMENSIONS = new Set(['concept', 'interactivity'])

/**
 * The brief sections interaction correctness sees.
 *
 * `interactions` is the specification, but it cannot stand alone: it says things
 * like "select the kth rectangle in panel (a) and highlight the corresponding
 * shell in panel (b)", and panels and shells are defined in the authored brief.
 * The textbook context is left out deliberately — it is prose about the
 * mathematics, of no use in deciding whether a slider updates the right quantity,
 * and precisely the material that pulled the concept agent into judging things
 * outside its remit.
 */
export const INTERACTIVITY_BRIEF_SECTIONS = ['identity', 'prompt', 'interactions']

/**
 * The brief sections concept accuracy sees — the exact complement of the above.
 *
 * Concept used to be handed the whole brief, `interactions` included, and its
 * prompt repeated interaction correctness's framing verbatim: that "Intended
 * interactions" is "the specification" for this dimension. It behaved
 * accordingly. Over the first four comparisons of one ablation run, every single
 * L-number the concept agent cited fell inside the interactions section and none
 * fell in the caption, the textbook context, or the authored brief; its
 * rationales were paraphrases of the interactivity agent's, and the two agreed
 * 4-0. That is one verdict cast twice, and the aggregator — told to up-weight
 * confidence, which both reported at 0.95-1.0 — read the pair as corroboration.
 *
 * Rewording the prompt alone would not hold. An agent given a list of requested
 * interactions grades compliance with it whatever it is told, which is the same
 * lesson INTERACTIVITY_BRIEF_SECTIONS above records in the other direction. So
 * the section is withheld: concept judges whether what a figure asserts is true,
 * against the caption and textbook context, and cannot grade a spec it cannot see.
 *
 * `interactions` is the last section of a brief, so this slice stays contiguous
 * from L00001 and its citations need no gap-reading.
 */
export const CONCEPT_BRIEF_SECTIONS = ['identity', 'caption', 'context', 'prompt']

async function callDimensionAgent(dimension, { htmlA, htmlB, thumbA, thumbB, sourceImage }, evalModel, numberedBrief = null, mode = '3d') {
  const systemPrompt = resolvePromptSet(mode)[dimension]
  const usesImages = dimension === 'faithfulness' || dimension === 'labels'

  const userContent = []

  if (GROUNDED_DIMENSIONS.has(dimension)) {
    if (!numberedBrief) throw new Error(`callDimensionAgent(${dimension}): numberedBrief is required`)
    userContent.push({ type: 'text', text: `Numbered figure brief:\n\n${numberedBrief}` })
    userContent.push({ type: 'text', text: `Figure 1 source code:\n\n${htmlA}` })
    userContent.push({ type: 'text', text: `Figure 2 source code:\n\n${htmlB}` })
  } else if (usesImages) {
    if (sourceImage) {
      userContent.push({ type: 'text', text: 'Reference textbook figure:' })
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${sourceImage}` } })
    }
    if (thumbA) {
      userContent.push({ type: 'text', text: 'Screenshot of Figure 1:' })
      userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumbA}` } })
    }
    if (thumbB) {
      userContent.push({ type: 'text', text: 'Screenshot of Figure 2:' })
      userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumbB}` } })
    }
  } else {
    userContent.push({ type: 'text', text: `Figure 1 source code:\n\n${htmlA}` })
    userContent.push({ type: 'text', text: `Figure 2 source code:\n\n${htmlB}` })
  }

  userContent.push({ type: 'text', text: 'Output ONLY the JSON object.' })

  const raw = await generateWithModel(evalModel, {
    systemPrompt,
    userContent,
    maxTokens: PAIRWISE_MAX_TOKENS,
  })

  return parseAgentJson(raw)
}

// ── Aggregator call ────────────────────────────────────────────────────────────

async function callAggregator(dimensionResults, evalModel) {
  const summary = Object.entries(dimensionResults).map(([dim, r]) =>
    `${dim}: winner=${r.winner}, confidence=${r.confidence}, rationale="${r.rationale}"`
  ).join('\n')

  const userContent = [
    { type: 'text', text: `Dimension agent results:\n${summary}\n\nOutput ONLY the JSON object.` },
  ]

  const raw = await generateWithModel(evalModel, {
    systemPrompt: AGGREGATOR_PROMPT,
    userContent,
    maxTokens: PAIRWISE_MAX_TOKENS,
  })

  return parseAgentJson(raw)
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Compare two figures across 5 dimensions plus an aggregator.
 * Position is randomized; all winner fields are resolved to setup names before return.
 *
 * @param {object} opts
 * @param {string} opts.htmlA       - HTML source for setup A's figure
 * @param {string} opts.setupA      - setup identifier (an experiments/ subfolder name)
 * @param {string} opts.htmlB       - HTML source for setup B's figure
 * @param {string} opts.setupB      - setup identifier
 * @param {string} [opts.thumbA]    - base64 JPEG screenshot for A (no data: prefix)
 * @param {string} [opts.thumbB]    - base64 JPEG screenshot for B
 * @param {string} [opts.sourceImage] - base64 PNG of the original benchmark figure
 * @param {string} [opts.evalModel] - model ID from MODEL_REGISTRY
 * @param {string} [opts.stem]      - figure stem, used to load the grounding brief
 * @param {string} [opts.briefContent] - pre-loaded brief, overrides `stem`
 * @param {{figure1: string, figure2: string}} [opts.positions] - which setup takes
 *   the Figure 1 slot. Omit to fall back to a coin flip; the batch route passes a
 *   counterbalanced assignment so the slots come out even across figures.
 * @returns {Promise<{figure1Setup, figure2Setup, mode, dimensions, aggregator, evalModel, evaluatedAt}>}
 */
export async function pairwiseEvaluateFigure({ htmlA, setupA, htmlB, setupB, thumbA, thumbB, sourceImage, evalModel, briefContent = null, stem = null, mode = '3d', positions = null }) {
  const usedModel = evalModel || PAIRWISE_DEFAULT_MODEL

  // Each grounded dimension gets the part of the brief it can act on, and the two
  // parts are disjoint: interaction correctness gets the authored description and
  // the requested interactions but not the textbook context, concept gets the
  // caption and textbook context but not the requested interactions — see
  // CONCEPT_BRIEF_SECTIONS for why. A caller supplying briefContent directly has
  // no section structure to slice, so both fall back to the whole text; that path
  // is for one-off calls and does not give the separation the graded runs rely on.
  if (!briefContent && !stem) throw new Error('pairwiseEvaluateFigure: briefContent or stem is required')
  const conceptBrief = briefContent
    ? numberLines(briefContent)
    : numberedBriefFor(stem, CONCEPT_BRIEF_SECTIONS)
  const interactivityBrief = briefContent
    ? numberLines(briefContent)
    : numberedBriefFor(stem, INTERACTIVITY_BRIEF_SECTIONS)

  // Decided once — the same assignment feeds all 5 dimensions and the aggregator,
  // so position bias is a property of this figure's verdict rather than something
  // that averages out inside it. Which is why the choice is counterbalanced across
  // figures upstream rather than left to a per-figure coin flip.
  const { figure1, figure2 } = resolvePositions(positions, setupA, setupB)
  const inputs = {
    htmlA: figure1 === setupA ? htmlA : htmlB,
    htmlB: figure1 === setupA ? htmlB : htmlA,
    thumbA: figure1 === setupA ? thumbA : thumbB,
    thumbB: figure1 === setupA ? thumbB : thumbA,
    sourceImage,
  }

  // 5 parallel dimension agents
  const [geometry, interactivity, faithfulness, labels, concept] = await Promise.all([
    callDimensionAgent('geometry', inputs, usedModel, null, mode),
    callDimensionAgent('interactivity', inputs, usedModel, interactivityBrief, mode),
    callDimensionAgent('faithfulness', inputs, usedModel, null, mode),
    callDimensionAgent('labels', inputs, usedModel, null, mode),
    callDimensionAgent('concept', inputs, usedModel, conceptBrief, mode),
  ])

  // Resolve 1/2 → setup names. Every dimension has the same shape; the concept
  // agent's line citations ride along inside its rationale.
  const rawDimensions = { geometry, interactivity, faithfulness, labels, concept }
  const resolvedDimensions = {}
  for (const [dim, result] of Object.entries(rawDimensions)) {
    resolvedDimensions[dim] = {
      winner: resolveWinner(result.winner, figure1, figure2, `the ${dim} agent`),
      confidence: result.confidence,
      rationale: result.rationale,
    }
  }

  // Aggregator — receives raw 1/2 labels (consistent with dimensions above)
  const aggRaw = await callAggregator(rawDimensions, usedModel)

  return {
    figure1Setup: figure1,
    figure2Setup: figure2,
    // Which prompt set produced this judgement — 2D and 3D score different things,
    // so a record is only comparable against others from the same mode.
    mode,
    dimensions: resolvedDimensions,
    aggregator: {
      winner: resolveWinner(aggRaw.winner, figure1, figure2, 'the aggregator'),
      confidence: aggRaw.confidence,
      explanation: aggRaw.explanation,
    },
    evalModel: usedModel,
    evaluatedAt: new Date().toISOString(),
  }
}

// ── Result file I/O ────────────────────────────────────────────────────────────
// One file per pair, in one of two places:
//
//   <judge dir>/<key>.json          machine verdicts — one set per judge
//   benchmark_results/human/<key>.json   human verdicts — one set, shared
//
// Both are dicts keyed "<subject>__<figure>". A machine record carries
// machineEval; a human record carries humanEvals. They are kept apart because a
// human verdict is the ground truth every judge is measured against, not one
// judge's opinion to be filed beside it — see HUMAN_SUBDIR in src/lib/judges.js.
// Readers that want a figure's whole story merge the two, which is what
// loadAllPairwiseResults and loadAllPairsForRanking do.

function pairFilePathIn(dir, setupA, setupB) {
  return path.join(dir, `${pairKey(setupA, setupB)}.json`)
}

function loadDict(dir, setupA, setupB) {
  const fp = pairFilePathIn(dir, setupA, setupB)
  if (!fs.existsSync(fp)) return {}
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) }
  catch { return {} }
}

function saveDict(dir, setupA, setupB, dict) {
  const fp = pairFilePathIn(dir, setupA, setupB)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, JSON.stringify(dict, null, 2))
}

/** Every dict in a directory, flattened. Skips subdirectories: they are not .json. */
function loadAllDicts(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try { return Object.values(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))) }
      catch { return [] }
    })
}

/**
 * Join a machine record and a human record for the same figure into the shape
 * the tables and the ranker expect. Either side may be missing: a figure can be
 * machine-evaluated and not yet judged, or judged before any run has reached it.
 */
function mergeRecord(machine, human) {
  const base = machine ?? human
  return {
    setupA: base.setupA,
    setupB: base.setupB,
    subject: base.subject,
    figure: base.figure,
    machineEval: machine?.machineEval ?? null,
    humanEvals: human?.humanEvals ?? [],
  }
}

const recordKey = r => `${pairKey(r.setupA, r.setupB)} ${r.subject}__${r.figure}`

// ── Machine verdicts, per judge ────────────────────────────────────────────────
// The judge is an optional trailing argument throughout, so omitting it resolves
// to the default judge — benchmark_results/ itself, exactly as before.

export function loadPairwiseResult(setupA, setupB, subject, figure, judge) {
  const dict = loadDict(resultsDirFor(judge), setupA, setupB)
  return dict[`${subject}__${figure}`] || null
}

export function savePairwiseResult(setupA, setupB, subject, figure, data, judge) {
  const dir = resultsDirFor(judge)
  const dict = loadDict(dir, setupA, setupB)
  // humanEvals never belong in a judge's file; drop it if a caller passes one
  // through out of habit, so the two stores cannot drift into disagreeing.
  const { humanEvals, ...machineOnly } = data
  void humanEvals
  dict[`${subject}__${figure}`] = machineOnly
  saveDict(dir, setupA, setupB, dict)
}

export function clearMachineEval(setupA, setupB, subject, figure, judge) {
  const dir = resultsDirFor(judge)
  const dict = loadDict(dir, setupA, setupB)
  const key = `${subject}__${figure}`
  if (dict[key]) {
    delete dict[key].machineEval
    saveDict(dir, setupA, setupB, dict)
  }
}

export function clearAllMachineEvals(setupA, setupB, judge) {
  const dir = resultsDirFor(judge)
  const dict = loadDict(dir, setupA, setupB)
  for (const key of Object.keys(dict)) delete dict[key].machineEval
  saveDict(dir, setupA, setupB, dict)
}

// ── Human verdicts, shared across judges ──────────────────────────────────────

export function loadHumanResult(setupA, setupB, subject, figure) {
  const dict = loadDict(HUMAN_RESULTS_DIR, setupA, setupB)
  return dict[`${subject}__${figure}`] || null
}

export function saveHumanResult(setupA, setupB, subject, figure, humanEvals) {
  const dict = loadDict(HUMAN_RESULTS_DIR, setupA, setupB)
  dict[`${subject}__${figure}`] = { setupA, setupB, subject, figure, humanEvals }
  saveDict(HUMAN_RESULTS_DIR, setupA, setupB, dict)
}

/** Human records for one pair — what the judging page needs, and nothing else. */
export function loadAllHumanResults(setupA, setupB) {
  return Object.values(loadDict(HUMAN_RESULTS_DIR, setupA, setupB))
}

/**
 * Every human verdict, for ranking the humans as a judge in their own right.
 *
 * No machine records are merged in: a ranking is a fit over one set of verdicts,
 * and this is that set. Which is also why it needs no judge argument — there is
 * only one human result set, shared by all of them.
 */
export function loadAllHumanForRanking() {
  return loadAllDicts(HUMAN_RESULTS_DIR)
}

// ── Merged views ──────────────────────────────────────────────────────────────

/** One pair's figures, with this judge's verdicts and the shared human ones. */
export function loadAllPairwiseResults(setupA, setupB, judge) {
  const machine = loadDict(resultsDirFor(judge), setupA, setupB)
  const human = loadDict(HUMAN_RESULTS_DIR, setupA, setupB)
  const keys = new Set([...Object.keys(machine), ...Object.keys(human)])
  return [...keys].map(k => mergeRecord(machine[k], human[k]))
}

/**
 * Every record this judge holds, merged with every human verdict, for ranking.
 *
 * Merging here rather than in the ranker is what lets buildRankings stay a pure
 * function of a flat record list — the same one the browser builds from the
 * static export.
 */
export function loadAllPairsForRanking(judge) {
  const merged = new Map()
  for (const r of loadAllDicts(resultsDirFor(judge))) {
    merged.set(recordKey(r), mergeRecord(r, null))
  }
  for (const r of loadAllDicts(HUMAN_RESULTS_DIR)) {
    const key = recordKey(r)
    merged.set(key, mergeRecord(merged.get(key), r))
  }
  return [...merged.values()]
}
