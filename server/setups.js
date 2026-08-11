/**
 * setups.js — discover experiment setups under experiments/.
 *
 * Layout: experiments/<experiment>/<stem>.html, flat, where <stem> matches an
 * entry in public/figures.json. One subfolder = one setup.
 *
 * Replaces visionbook's scanExperiments/scanAgentResults/scanAgentBatchOutputs,
 * which had to cope with an experiment/model tree plus a results database.
 */

import fs from 'fs'
import path from 'path'
import { REPO_ROOT, figureMeta, figureImagePath } from './contexts.js'
import { joinMatchingFigures } from '../src/lib/pairs.js'

export const EXPERIMENTS_DIR = path.join(REPO_ROOT, 'experiments')

/**
 * Pre-rendered figure screenshots, written by server/capture_screenshots.js.
 * Regenerable and gitignored — the evaluator falls back to rendering on demand
 * and the Outputs tab falls back to the reference image.
 */
export const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'screenshots')

/** Where one setup's rendered screenshot of one figure lives. */
export function screenshotFilePath(setupId, stem) {
  return path.join(SCREENSHOTS_DIR, setupId, `${stem}.jpg`)
}

/**
 * Map an experiment filename back to its figure stem in figures.json.
 *
 * Generators name their output `<stem>__<runid>.html`, and some flatten the dots
 * in numeric stems to underscores (`14_2_10` for `14.2.10`). Each candidate is
 * tested against figures.json rather than transformed blindly, so stems that
 * genuinely contain underscores (`CNX_Chem_01_01_FuelCell`) match as-is and are
 * never mangled by the dot fallback.
 *
 * @returns the resolved stem, or null if no candidate is a known figure.
 */
export function resolveStem(fileName) {
  const base = fileName.replace(/\.html$/, '')
  const candidates = [base, base.replace(/__[A-Za-z0-9]+$/, '')]
  for (const c of [...candidates, ...candidates.map(c => c.replace(/_/g, '.'))]) {
    if (figureMeta(c)) return c
  }
  return null
}

/**
 * @returns {Array<{id: string, figures: Array<{stem, subject, type, htmlPath, imagePath, screenshotPath, hasScreenshot}>}>}
 * `screenshotPath` is where the capture belongs whether or not it exists yet;
 * `hasScreenshot` says whether it is actually there.
 * Figures whose stem is absent from figures.json are skipped — the evaluator has
 * no reference image or context row for them.
 */
export function scanSetups() {
  if (!fs.existsSync(EXPERIMENTS_DIR)) return []

  const setups = []
  for (const entry of fs.readdirSync(EXPERIMENTS_DIR).sort()) {
    const dir = path.join(EXPERIMENTS_DIR, entry)
    if (!fs.statSync(dir).isDirectory()) continue

    const figures = []
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.html')) continue
      const stem = resolveStem(file)
      const meta = stem && figureMeta(stem)
      if (!meta) {
        console.warn(`[setups] ${entry}/${file}: no matching stem in figures.json — skipped`)
        continue
      }
      const screenshotPath = screenshotFilePath(entry, stem)
      figures.push({
        stem,
        subject: meta.subject,
        type: meta.type,
        htmlPath: path.join(dir, file),
        imagePath: figureImagePath(stem),
        screenshotPath,
        hasScreenshot: fs.existsSync(screenshotPath),
      })
    }

    setups.push({ id: entry, figures })
  }
  return setups
}

/** Figures present in both setups. See joinMatchingFigures for the join rule. */
export function matchingFigures(setupA, setupB) {
  return joinMatchingFigures(scanSetups(), setupA, setupB)
}
