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
export function loadFigureBrief(stem) {
  const row = contextsIndex().get(String(stem))
  if (!row) throw new Error(`No context row for figure "${stem}" in contexts_export.json`)

  const meta = figureMeta(stem)
  const sections = [
    `Figure: ${stem}`,
    `Subject: ${row.domain || meta?.subject || 'unknown'}`,
    `Figure type: ${row.type || meta?.type || 'unknown'}`,
    `Source: ${row.source || 'unknown'}`,
  ]
  if (row.caption) sections.push('', 'Caption:', row.caption)
  if (row.context) sections.push('', 'Textbook context:', row.context)
  if (row['input prompt']) sections.push('', 'Authored figure brief:', row['input prompt'])
  if (row.interactions) sections.push('', 'Intended interactions:', row.interactions)

  return sections.join('\n')
}
