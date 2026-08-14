/**
 * judges.js — who evaluated a comparison, and where that verdict is kept.
 *
 * A "judge" is the model that runs the pairwise comparison. Verdicts from
 * different judges must never share a file: they disagree, and a Bradley-Terry
 * ranking over a mixture of two judges is a ranking of nothing in particular. So
 * each judge gets its own result set and each is planned, resumed and ranked
 * independently.
 *
 * Every judge lives in a subdirectory of its own and none owns the results root.
 * The first judge did own it, back when it was the only one, and keeping that
 * arrangement would have meant one judge with no folder and the rest with one —
 * a special case every reader and the static export had to carry. The symmetric
 * layout costs a one-time move of the existing results and removes it.
 *
 * Pure data and string handling, no imports — like pairs.js and rankings.js it
 * has to run in Node (the API, the CLI, the Vite build) and in the browser (a
 * deployed read-only site, which resolves the same layout over HTTP).
 */

/**
 * Judge id → the directory under benchmark_results/ holding its pair files.
 *
 * The id is also a MODEL_REGISTRY key in server/models.js, so the model chosen
 * to evaluate with is the only thing that decides where results land; there is
 * no second setting that could disagree with it. server/judges.test.js pins
 * those two lists together, and also pins the subdirs to being present, unique,
 * and distinct from the human set.
 */
export const JUDGES = {
  'gemini-3.1-pro': { label: 'Gemini 3.1 Pro', resultsSubdir: 'gemini' },
  'gpt-5.5': { label: 'GPT-5.5', resultsSubdir: 'gpt5.5' },
}

export const DEFAULT_JUDGE = 'gemini-3.1-pro'

/**
 * Where human verdicts live — one folder, outside every judge's.
 *
 * A human verdict is not a judge's opinion to be filed alongside it; it is the
 * ground truth those opinions are measured against. Storing it per judge would
 * mean the same person judging the same figure twice, once for each machine
 * judge, and a verdict recorded while viewing GPT-5.5 would be invisible when
 * viewing Gemini — which is exactly the comparison the human labels exist to
 * support. So there is one human result set and every judge is scored against it.
 *
 * The layout mirrors a judge's: one file per pair, keyed <subject>__<figure>,
 * carrying humanEvals and no machineEval.
 */
export const HUMAN_SUBDIR = 'human'
export const HUMAN_STATIC_PREFIX = `${HUMAN_SUBDIR}/`

/** Judge ids in a stable order, for the UI's selector. */
export function availableJudges() {
  return Object.entries(JUDGES).map(([id, { label }]) => ({ id, label, isDefault: id === DEFAULT_JUDGE }))
}

/**
 * Who a ranking can be built from: each machine judge, plus the humans.
 *
 * Ranking treats a human verdict as one more judge's opinion, because that is
 * what a ranking *is* — a fit over one set of verdicts, and the whole reason to
 * keep the sets apart. It is only for storage that human is the odd one out
 * (one shared folder, no per-dimension verdicts); for the purpose of "rank the
 * setups by what X thought", human is simply another X.
 *
 * `kind` is what callers branch on: 'machine' reads machineEval and has a
 * ranking per dimension, 'human' reads humanEvals and has an overall only.
 */
export function rankingSources() {
  return [
    ...availableJudges().map(({ id, label }) => ({ id, label, kind: 'machine' })),
    { id: HUMAN_SUBDIR, label: 'Human', kind: 'human' },
  ]
}

/** True when a ranking source id names the human verdicts rather than a judge. */
export function isHumanSource(sourceId) {
  return sourceId === HUMAN_SUBDIR
}

/**
 * Validate a ranking source, defaulting a blank to the default judge. Throws on
 * anything unrecognised, for the same reason judgeFor does.
 */
export function rankingSourceFor(sourceId) {
  const id = sourceId || DEFAULT_JUDGE
  const found = rankingSources().find(s => s.id === id)
  if (!found) {
    throw new Error(`unknown judge: "${sourceId}". Known judges: ${rankingSources().map(s => s.id).join(', ')}`)
  }
  return found
}

/**
 * Look a judge up, treating a blank id as "the default".
 *
 * An unrecognised id throws. The tempting alternative — falling back to the
 * default judge — would take a mistyped `--model` and write GPT verdicts into
 * the Gemini run's files, which is unrecoverable short of re-running everything.
 */
export function judgeFor(judgeId) {
  const id = judgeId || DEFAULT_JUDGE
  const entry = JUDGES[id]
  if (!entry) {
    throw new Error(`unknown judge: "${judgeId}". Known judges: ${Object.keys(JUDGES).join(', ')}`)
  }
  return entry
}

/** The single directory segment a judge's files sit under. */
export function subdirFor(judgeId) {
  return judgeFor(judgeId).resultsSubdir
}

/** Path prefix for a judge's files in the static export, ending in a slash. */
export function staticPrefixFor(judgeId) {
  return `${subdirFor(judgeId)}/`
}
