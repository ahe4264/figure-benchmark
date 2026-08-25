/**
 * figures_manifest.js — public/figures.json is generated, never hand-edited.
 *
 * The manifest mirrors what is on disk under public/images/, so removing a
 * figure from the benchmark means moving its file out of that tree and letting
 * the manifest be rewritten from the tree afterwards. The Vite plugin syncs on
 * boot and on every add/unlink.
 */

import fs from 'fs'
import path from 'path'
import { PUBLIC_DIR, IMAGES_DIR } from './contexts.js'

const MANIFEST = path.join(PUBLIC_DIR, 'figures.json')

/**
 * Rewrite public/figures.json from the files under public/images/.
 * @returns {Array<{stem: string, subject: string, type: string, ext: string}>}
 */
export function syncFiguresManifest() {
  const figures = []
  for (const subject of fs.readdirSync(IMAGES_DIR)) {
    const subjectDir = path.join(IMAGES_DIR, subject)
    if (!fs.statSync(subjectDir).isDirectory()) continue
    for (const type of fs.readdirSync(subjectDir)) {
      const typeDir = path.join(subjectDir, type)
      if (!fs.statSync(typeDir).isDirectory()) continue
      for (const file of fs.readdirSync(typeDir)) {
        const ext = path.extname(file)
        if (!ext) continue
        if (subject === 'cs' && ext === '.svg') continue
        figures.push({ stem: path.basename(file, ext), subject, type, ext })
      }
    }
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(figures, null, 2), 'utf8')
  console.log(`[figures] synced ${figures.length} figures to figures.json`)
  return figures
}
