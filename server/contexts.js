/**
 * contexts.js — figure metadata and the "figure brief" fed to the concept agent.
 *
 * Replaces visionbook's qmd_utils.js. There is no textbook source here; the
 * equivalent grounding text is the curated row in public/contexts_export.json
 * (textbook context, authored prompt, intended interactions). `numberLines` is
 * kept verbatim so the concept agent can cite the brief by L-number.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '..')
export const PUBLIC_DIR = path.join(REPO_ROOT, 'public')
export const IMAGES_DIR = path.join(PUBLIC_DIR, 'images')

let _figures = null
let _contexts = null

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

/** stem -> { stem, subject, type, ext } from public/figures.json */
function figuresIndex() {
  if (!_figures) {
    _figures = new Map()
    for (const f of loadJson(path.join(PUBLIC_DIR, 'figures.json'))) {
      _figures.set(String(f.stem), f)
    }
  }
  return _figures
}

/**
 * stem -> curated context row from public/contexts_export.json.
 * figure_id is coerced to a string: a handful of rows carry numeric ids
 * (2.2, 6.3, …) that must still match their string stem in figures.json.
 */
function contextsIndex() {
  if (!_contexts) {
    _contexts = new Map()
    for (const c of loadJson(path.join(PUBLIC_DIR, 'contexts_export.json'))) {
      if (c.figure_id !== undefined && c.figure_id !== null) _contexts.set(String(c.figure_id), c)
    }
  }
  return _contexts
}

/** Drop the in-memory caches (used when the manifests change on disk). */
export function invalidateCaches() {
  _figures = null
  _contexts = null
}

/** @returns {{stem, subject, type, ext}|null} */
export function figureMeta(stem) {
  return figuresIndex().get(String(stem)) || null
}

/** Absolute path to a figure's reference image under public/images/, or null. */
export function figureImagePath(stem) {
  const meta = figureMeta(stem)
  if (!meta) return null
  const p = path.join(IMAGES_DIR, meta.subject, meta.type, `${meta.stem}${meta.ext || '.png'}`)
  return fs.existsSync(p) ? p : null
}

/**
 * Which pairwise prompt set a figure should be judged with — '2d' or '3d'.
 * figures.json is authoritative here, so unlike visionbook there is no need to
 * sniff the generated HTML for the libraries it loads.
 */
export function resolveMode(stem) {
  const type = figureMeta(stem)?.type
  return type === '2d' ? '2d' : '3d'
}

/** Prefix every line with its 1-based number, so agents can cite line ranges. */
export function numberLines(text) {
  return text.split('\n')
    .map((line, i) => `L${String(i + 1).padStart(5, '0')}: ${line}`)
    .join('\n')
}

/**
 * Assemble the grounding text for a figure. Mirrors the role the numbered QMD
 * chapter plays in visionbook's concept agent.
 * @throws if the stem has no row in contexts_export.json
 */
/** The named parts of a brief, in the order they are assembled. */
export const BRIEF_SECTIONS = ['identity', 'caption', 'context', 'prompt', 'interactions']

/**
 * The brief as tagged lines, so a caller can take a subset of it.
 *
 * Not every dimension wants the whole thing. Interaction correctness needs the
 * authored brief — the `interactions` text refers to "panel (a)" and "the kth
 * rectangle" without defining them — but has no use for the textbook context,
 * which is prose about the mathematics and only invites judgements outside the
 * dimension's remit.
 *
 * @returns {Array<{section: string, text: string}>} one entry per line
 */
export function figureBriefLines(stem) {
  const row = contextsIndex().get(String(stem))
  if (!row) throw new Error(`No context row for figure "${stem}" in contexts_export.json`)

  const meta = figureMeta(stem)
  const out = []
  // Split on newlines here rather than at render time: a field holding several
  // lines has to occupy several numbered lines, or a citation cannot point
  // inside it.
  const push = (section, ...blocks) => {
    for (const block of blocks) {
      for (const line of String(block).split('\n')) out.push({ section, text: line })
    }
  }

  push('identity',
    `Figure: ${stem}`,
    `Subject: ${row.domain || meta?.subject || 'unknown'}`,
    `Figure type: ${row.type || meta?.type || 'unknown'}`,
    `Source: ${row.source || 'unknown'}`)
  if (row.caption) push('caption', '', 'Caption:', row.caption)
  if (row.context) push('context', '', 'Textbook context:', row.context)
  if (row['input prompt']) push('prompt', '', 'Authored figure brief:', row['input prompt'])
  if (row.interactions) push('interactions', '', 'Intended interactions:', row.interactions)

  return out
}

export function loadFigureBrief(stem) {
  return figureBriefLines(stem).map(l => l.text).join('\n')
}

/**
 * A numbered brief restricted to some sections.
 *
 * Line numbers are those of the *whole* brief, so a subset keeps the numbering it
 * would have had. That is what lets an L-number mean the same line whichever
 * dimension cites it — without it, "L00012" in an interactivity rationale and in
 * a concept rationale would point at different text, and the two would be
 * impossible to read side by side.
 *
 * @param {string[]|null} sections names from BRIEF_SECTIONS; null means all
 */
export function numberedBriefFor(stem, sections = null) {
  const want = sections ? new Set(sections) : null
  return figureBriefLines(stem)
    .map((line, i) => ({ ...line, n: i + 1 }))
    .filter(line => !want || want.has(line.section))
    .map(line => `L${String(line.n).padStart(5, '0')}: ${line.text}`)
    .join('\n')
}
