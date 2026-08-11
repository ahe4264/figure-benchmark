// URLs for files that live outside public/: generated figures under experiments/
// and reference images under public/images/.
//
// In dev they are served by the benchmark API, which resolves an absolute
// filesystem path against an allowed root and 404s on anything outside it. A
// production build has no API, so the static exporter copies those files into
// dist/ and emits dist-relative paths instead, which are served as plain files.
// Which kind of path is in `figure.htmlPath` is decided at build time, so the
// two never mix.

import { READ_ONLY } from './api.js'

/** dist-relative POSIX path -> absolute URL, encoding each segment. */
function staticUrl(relPath) {
  return '/' + relPath.split('/').map(encodeURIComponent).join('/')
}

/** URL for a generated figure's HTML. */
export function htmlUrl(htmlPath) {
  if (!htmlPath) return null
  return READ_ONLY ? staticUrl(htmlPath) : `/api/experiments/html?path=${encodeURIComponent(htmlPath)}`
}

/** URL for a figure's pre-rendered screenshot (see server/capture_screenshots.js). */
export function screenshotUrl(screenshotPath) {
  if (!screenshotPath) return null
  return READ_ONLY ? staticUrl(screenshotPath) : `/api/experiments/screenshot?path=${encodeURIComponent(screenshotPath)}`
}

/** URL for a figure's reference image. */
export function imageUrl(imagePath) {
  if (!imagePath) return null
  return READ_ONLY ? staticUrl(imagePath) : `/api/experiments/imageurl?path=${encodeURIComponent(imagePath)}`
}

/**
 * A figure's URL on the standalone output page, which opens in its own tab.
 * Subject and type ride along so the header can render before the setup list has
 * loaded, and so a stem that repeats across subjects still resolves to one figure.
 */
export function outputUrl(fig) {
  const qs = new URLSearchParams({
    setup: fig.setup, stem: fig.stem, subject: fig.subject, type: fig.type,
  })
  return `${window.location.pathname}#output?${qs}`
}
