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
import { loadFigureBrief, numberLines, REPO_ROOT } from './contexts.js'
import { pairKey } from '../src/lib/pairs.js'

const PAIRWISE_DEFAULT_MODEL = DEFAULT_MODEL_ID
const PAIRWISE_MAX_TOKENS = 16384
const PAIRWISE_RESULTS_DIR = path.join(REPO_ROOT, 'benchmark_results')

// ── Position helpers ──────────────────────────────────────────────────────────
// pairKey lives in src/lib/pairs.js so the browser can derive the same result
// filenames from a static export (see the import at the top of this file).

function randomizeOrder(setupA, setupB) {
  return Math.random() < 0.5
    ? { figure1: setupA, figure2: setupB }
    : { figure1: setupB, figure2: setupA }
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

function parseAgentJson(raw) {
  let content = raw
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) content = fenced[1].trim()
  content = content.trim()
  return JSON.parse(content)
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

DIMENSION: Interaction correctness — which figure's controls do the right thing. Judge the controls and their behaviour.
Evaluate: whether each handler recomputes and redraws what it claims to, whether its effect on the figure is the one the control advertises, and whether the figure holds up at the extremes of every control and at degenerate inputs.
Watch for: an effect that runs backwards, a handler computing the wrong quantity, ranges that admit non-physical states, a bad input silently swallowed so a stale figure stays on screen, a displayed value that disagrees with what is drawn.
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

DIMENSION: Concept accuracy — which figure teaches the concept more correctly. Judge what the figure and its labels assert.
The figure brief is the ground truth for this figure. Every line of it is prefixed with a line number (L00001:, L00002:, …) so you can cite it exactly.
Work out the 1-4 key concepts the brief says this figure should teach — anchoring each to the brief lines that state it — then judge how truthfully each figure represents them.
Evaluate: whether the geometry, labels, and annotations assert what the brief asserts; whether the relationships shown hold on the subject's own terms, not just for the case drawn; and whether a student reading this figure would come away with a correct understanding.
Watch for: a wrong sign or direction, a wrong relationship or limiting behaviour, a mislabelled quantity or axis, a claim true only of the drawn instance, statements that contradict or ignore the brief. The original figure is context, not ground truth — an error still counts when the original shares it.
Cite the brief lines each judgement rests on, as L-numbers in parentheses: a single line (L00031) or a range (L00012-L00014). Judge against what those lines actually state — do not fault a figure for omitting something the brief never asks for, and do not credit a claim the brief does not support.
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

const AGGREGATOR_PROMPT = `You receive pairwise preferences from five independent dimension agents that each compared Figure 1 vs Figure 2.
Synthesize a final judgment. Up-weight agents with higher confidence.
Only call "tie" if the dimension votes are split with no clear overall winner.
Your explanation must be comparative: cite specific strengths of the winner over the loser and specific weaknesses of the loser relative to the winner — not just a list of the winner's merits in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"explanation":"<two to three sentences comparing both figures>"}`

// ── Single dimension agent call ────────────────────────────────────────────────

async function callDimensionAgent(dimension, { htmlA, htmlB, thumbA, thumbB, sourceImage }, evalModel, numberedBrief = null, mode = '3d') {
  const systemPrompt = resolvePromptSet(mode)[dimension]
  const usesImages = dimension === 'faithfulness' || dimension === 'labels'

  const userContent = []

  if (dimension === 'concept') {
    if (!numberedBrief) throw new Error('callDimensionAgent(concept): numberedBrief is required')
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
 * @returns {Promise<{figure1Setup, figure2Setup, mode, dimensions, aggregator, evalModel, evaluatedAt}>}
 */
export async function pairwiseEvaluateFigure({ htmlA, setupA, htmlB, setupB, thumbA, thumbB, sourceImage, evalModel, briefContent = null, stem = null, mode = '3d' }) {
  const usedModel = evalModel || PAIRWISE_DEFAULT_MODEL

  let resolvedBrief = briefContent
  if (!resolvedBrief && stem) resolvedBrief = loadFigureBrief(stem)
  if (!resolvedBrief) throw new Error('pairwiseEvaluateFigure: briefContent or stem is required')
  const numberedBrief = numberLines(resolvedBrief)

  // Randomize once — same assignment used for all 5 dimensions and the aggregator
  const { figure1, figure2 } = randomizeOrder(setupA, setupB)
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
    callDimensionAgent('interactivity', inputs, usedModel, null, mode),
    callDimensionAgent('faithfulness', inputs, usedModel, null, mode),
    callDimensionAgent('labels', inputs, usedModel, null, mode),
    callDimensionAgent('concept', inputs, usedModel, numberedBrief, mode),
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
// One file per pair: benchmark_results/<key>.json
// Contents: { "<subject>__<figure>": { setupA, setupB, subject, figure, machineEval, humanEvals }, ... }

function pairFilePath(setupA, setupB) {
  return path.join(PAIRWISE_RESULTS_DIR, `${pairKey(setupA, setupB)}.json`)
}

function loadPairFile(setupA, setupB) {
  const fp = pairFilePath(setupA, setupB)
  if (!fs.existsSync(fp)) return {}
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) }
  catch { return {} }
}

function savePairFile(setupA, setupB, dict) {
  const fp = pairFilePath(setupA, setupB)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, JSON.stringify(dict, null, 2))
}

export function loadPairwiseResult(setupA, setupB, subject, figure) {
  const dict = loadPairFile(setupA, setupB)
  return dict[`${subject}__${figure}`] || null
}

export function savePairwiseResult(setupA, setupB, subject, figure, data) {
  const dict = loadPairFile(setupA, setupB)
  dict[`${subject}__${figure}`] = data
  savePairFile(setupA, setupB, dict)
}

export function loadAllPairwiseResults(setupA, setupB) {
  return Object.values(loadPairFile(setupA, setupB))
}

export function loadAllPairsForRanking() {
  if (!fs.existsSync(PAIRWISE_RESULTS_DIR)) return []
  return fs.readdirSync(PAIRWISE_RESULTS_DIR)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try { return Object.values(JSON.parse(fs.readFileSync(path.join(PAIRWISE_RESULTS_DIR, f), 'utf-8'))) }
      catch { return [] }
    })
}

export function clearMachineEval(setupA, setupB, subject, figure) {
  const dict = loadPairFile(setupA, setupB)
  const key = `${subject}__${figure}`
  if (dict[key]) {
    delete dict[key].machineEval
    savePairFile(setupA, setupB, dict)
  }
}

export function clearAllMachineEvals(setupA, setupB) {
  const dict = loadPairFile(setupA, setupB)
  for (const key of Object.keys(dict)) delete dict[key].machineEval
  savePairFile(setupA, setupB, dict)
}
