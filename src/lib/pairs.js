/**
 * pairs.js — pair identity and the setup-vs-setup figure join.
 *
 * Shared by the dev API and the browser: in a production build there is no
 * server to do the join, so the client does it against the exported setups.json.
 * Keeping one implementation is what stops the two from drifting.
 */

export function canonicalizePair(setupA, setupB) {
  const [s1, s2] = [setupA, setupB].sort()
  return { canonical1: s1, canonical2: s2 }
}

/** Filename-safe, order-independent key for a pair of setups. */
export function pairKey(setupA, setupB) {
  const { canonical1, canonical2 } = canonicalizePair(setupA, setupB)
  return `${canonical1.replace(/\//g, '__')}_vs_${canonical2.replace(/\//g, '__')}`
}

/**
 * Figures present in both setups, in the shape the batch-evaluate route and the
 * UI expect. Joined on stem alone — stems are globally unique in figures.json.
 *
 * @param {Array<{id: string, figures: Array}>} allSetups output of scanSetups()
 */
export function joinMatchingFigures(allSetups, setupA, setupB) {
  const sa = allSetups.find(s => s.id === setupA)
  const sb = allSetups.find(s => s.id === setupB)
  if (!sa || !sb) return []

  const bByStem = new Map(sb.figures.map(f => [f.stem, f]))
  const out = []
  for (const f of sa.figures) {
    const bFig = bByStem.get(f.stem)
    if (!bFig) continue
    out.push({
      name: f.stem,
      subject: f.subject,
      type: f.type,
      htmlPathA: f.htmlPath,
      imagePathA: f.imagePath,
      screenshotPathA: f.screenshotPath ?? null,
      hasScreenshotA: !!f.hasScreenshot,
      htmlPathB: bFig.htmlPath,
      imagePathB: bFig.imagePath,
      screenshotPathB: bFig.screenshotPath ?? null,
      hasScreenshotB: !!bFig.hasScreenshot,
    })
  }
  return out
}
