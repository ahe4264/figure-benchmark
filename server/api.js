/**
 * api.js — the benchmark API, mounted as connect middleware by the Vite plugin.
 *
 * Route bodies are ported from visionbook/figure-platform/backend/server.js
 * (the /api/pairwise/* and /api/experiments/* families). Express isn't needed:
 * Vite's dev server is connect-based, so a small router over (req, res) does.
 */

import fs from 'fs'
import path from 'path'
import { getAvailableModels } from './models.js'
import { figureMeta, resolveMode, IMAGES_DIR } from './contexts.js'
import { scanSetups, matchingFigures, EXPERIMENTS_DIR, SCREENSHOTS_DIR } from './setups.js'
import { screenshotHtml } from './screenshot.js'
import { buildRankings } from '../src/lib/rankings.js'
import {
  pairwiseEvaluateFigure,
  loadPairwiseResult,
  savePairwiseResult,
  loadAllPairwiseResults,
  loadAllPairsForRanking,
  clearMachineEval,
  clearAllMachineEvals,
} from './pairwise_evaluator.js'

// ── Small helpers ─────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

/**
 * Resolve a client-supplied ?path= against an allowed root.
 * Returns null unless the resolved path stays inside `root` and exists — this
 * is what stops `?path=../../../../etc/passwd`.
 */
function safeResolve(rawPath, root) {
  if (!rawPath) return null
  const abs = path.resolve(rawPath)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return fs.existsSync(abs) ? abs : null
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
}

// ── Figure assets ─────────────────────────────────────────────────────────────

/**
 * Read the HTML, a rendered screenshot, and the reference image for one side of
 * a comparison.
 *
 * The screenshot normally comes straight off disk — `npm run screenshots`
 * pre-renders every figure into screenshots/<setup>/<stem>.jpg. Rendering here
 * is the fallback for a figure that sweep hasn't covered yet, and it writes into
 * the same cache, so an eval run also warms the Outputs tab.
 */
async function readFigureAssets(htmlPath, imagePath, screenshotPath) {
  if (!htmlPath || !fs.existsSync(htmlPath)) return null
  const html = fs.readFileSync(htmlPath, 'utf-8')

  let thumb = screenshotPath && fs.existsSync(screenshotPath)
    ? fs.readFileSync(screenshotPath).toString('base64')
    : null

  if (!thumb) {
    const shot = await screenshotHtml(html)
    if (shot) {
      thumb = shot.data
      if (screenshotPath) {
        try {
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
          const tmp = `${screenshotPath}.tmp`
          fs.writeFileSync(tmp, Buffer.from(thumb, 'base64'))
          fs.renameSync(tmp, screenshotPath)
        } catch (err) {
          console.warn(`[api] could not cache screenshot for ${htmlPath}: ${err.message}`)
        }
      }
    }
  }

  let sourceImg = null
  if (imagePath && fs.existsSync(imagePath)) sourceImg = fs.readFileSync(imagePath).toString('base64')

  return { html, thumb, sourceImg }
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function handleBatchEvaluate(req, res) {
  const body = await readBody(req)
  const { setupA, setupB, figures, evalModel, skipExisting = true } = body
  if (!setupA || !setupB) return sendJson(res, 400, { error: 'setupA and setupB are required.' })
  if (!Array.isArray(figures) || figures.length === 0) return sendJson(res, 400, { error: 'figures array is required.' })

  // Re-derive the figure paths server-side rather than trusting the request body,
  // so a crafted htmlPath can't pull a file from outside experiments/.
  const trusted = new Map(matchingFigures(setupA, setupB).map(f => [f.name, f]))

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  for (const requested of figures) {
    const name = requested?.name
    const fig = trusted.get(name)
    if (!fig) {
      res.write(JSON.stringify({ name, subject: requested?.subject, status: 'error', error: 'Figure is not present in both setups.' }) + '\n')
      continue
    }
    const subject = fig.subject
    try {
      if (skipExisting) {
        const existing = loadPairwiseResult(setupA, setupB, subject, name)
        if (existing?.machineEval) {
          res.write(JSON.stringify({ name, subject, status: 'skipped' }) + '\n')
          continue
        }
      }

      const [assetsA, assetsB] = await Promise.all([
        readFigureAssets(fig.htmlPathA, fig.imagePathA, fig.screenshotPathA),
        readFigureAssets(fig.htmlPathB, fig.imagePathB, fig.screenshotPathB),
      ])
      if (!assetsA || !assetsB) {
        res.write(JSON.stringify({ name, subject, status: 'error', error: 'HTML assets not found.' }) + '\n')
        continue
      }

      const evalResult = await pairwiseEvaluateFigure({
        htmlA: assetsA.html,
        setupA,
        htmlB: assetsB.html,
        setupB,
        thumbA: assetsA.thumb,
        thumbB: assetsB.thumb,
        sourceImage: assetsA.sourceImg || assetsB.sourceImg,
        evalModel,
        stem: name,
        mode: resolveMode(name),
      })

      // Load existing record (to preserve humanEvals) or start fresh
      const existing = loadPairwiseResult(setupA, setupB, subject, name) || { setupA, setupB, subject, figure: name, humanEvals: [] }
      savePairwiseResult(setupA, setupB, subject, name, { ...existing, machineEval: evalResult })

      res.write(JSON.stringify({ name, subject, status: 'ok', result: evalResult }) + '\n')
    } catch (err) {
      console.error(`[pairwise] eval error for ${subject}/${name}:`, err?.message || err)
      res.write(JSON.stringify({ name, subject, status: 'error', error: err?.message || 'Evaluation failed.' }) + '\n')
    }
  }

  res.end()
}

function handleRankings(res, url) {
  const setupsParam = url.searchParams.get('setups')
  const allowed = setupsParam !== null ? setupsParam.split(',').filter(Boolean) : null
  return sendJson(res, 200, buildRankings(loadAllPairsForRanking(), allowed))
}

function serveFile(res, abs, contentType) {
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  fs.createReadStream(abs).pipe(res)
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * @returns a connect middleware. Mounted at /api, so req.url here is already
 * stripped of the /api prefix (e.g. "/pairwise/setups?setupA=…").
 */
export function createApiHandler() {
  return async function apiHandler(req, res, next) {
    const url = new URL(req.url, 'http://localhost')
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const method = req.method

    try {
      // GET /models
      if (method === 'GET' && seg[0] === 'models' && seg.length === 1) {
        return sendJson(res, 200, getAvailableModels())
      }

      // GET /setups — every experiment and its figures, for the Outputs tab.
      // Same data as /pairwise/setups minus the two-setup matching.
      if (method === 'GET' && seg[0] === 'setups' && seg.length === 1) {
        return sendJson(res, 200, { setups: scanSetups() })
      }

      // GET /experiments/html?path=…
      if (method === 'GET' && seg[0] === 'experiments' && seg[1] === 'html') {
        const abs = safeResolve(url.searchParams.get('path'), EXPERIMENTS_DIR)
        if (!abs) { res.statusCode = 404; return res.end('Not found') }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html')
        return res.end(fs.readFileSync(abs, 'utf-8'))
      }

      // GET /experiments/screenshot?path=… — a pre-rendered figure capture
      if (method === 'GET' && seg[0] === 'experiments' && seg[1] === 'screenshot') {
        const abs = safeResolve(url.searchParams.get('path'), SCREENSHOTS_DIR)
        if (!abs) { res.statusCode = 404; return res.end('') }
        return serveFile(res, abs, 'image/jpeg')
      }

      // GET /experiments/imageurl?path=…
      if (method === 'GET' && seg[0] === 'experiments' && seg[1] === 'imageurl') {
        const abs = safeResolve(url.searchParams.get('path'), IMAGES_DIR)
        if (!abs) { res.statusCode = 404; return res.end('') }
        return serveFile(res, abs, MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream')
      }

      if (seg[0] === 'pairwise') {
        // GET /pairwise/setups[?setupA=&setupB=]
        if (method === 'GET' && seg[1] === 'setups') {
          const setups = scanSetups()
          const setupA = url.searchParams.get('setupA')
          const setupB = url.searchParams.get('setupB')
          const matches = setupA && setupB && setupA !== setupB ? matchingFigures(setupA, setupB) : null
          return sendJson(res, 200, { setups, matchingFigures: matches })
        }

        // GET /pairwise/results/:setupA/:setupB
        if (method === 'GET' && seg[1] === 'results' && seg.length === 4) {
          return sendJson(res, 200, loadAllPairwiseResults(seg[2], seg[3]))
        }

        // GET /pairwise/rankings[?setups=a,b]
        if (method === 'GET' && seg[1] === 'rankings') {
          return handleRankings(res, url)
        }

        // POST /pairwise/batch-evaluate
        if (method === 'POST' && seg[1] === 'batch-evaluate') {
          return await handleBatchEvaluate(req, res)
        }

        // POST|DELETE /pairwise/human-evaluate
        if (seg[1] === 'human-evaluate' && (method === 'POST' || method === 'DELETE')) {
          const { setupA, setupB, subject, figure, winner, notes } = await readBody(req)
          if (!setupA || !setupB || !subject || !figure)
            return sendJson(res, 400, { error: 'setupA, setupB, subject, figure are required.' })

          if (method === 'DELETE') {
            const existing = loadPairwiseResult(setupA, setupB, subject, figure)
            if (existing) savePairwiseResult(setupA, setupB, subject, figure, { ...existing, humanEvals: [] })
            return sendJson(res, 200, { success: true })
          }

          if (!winner) return sendJson(res, 400, { error: 'winner is required.' })
          const existing = loadPairwiseResult(setupA, setupB, subject, figure) || { setupA, setupB, subject, figure, humanEvals: [] }
          const humanEval = { winner, notes: notes || '', submittedAt: new Date().toISOString() }
          savePairwiseResult(setupA, setupB, subject, figure, { ...existing, humanEvals: [...(existing.humanEvals || []), humanEval] })
          return sendJson(res, 200, { success: true, humanEval })
        }

        // DELETE /pairwise/machine-eval/:setupA/:setupB[/:subject/:figure]
        if (method === 'DELETE' && seg[1] === 'machine-eval') {
          if (seg.length === 4) {
            clearAllMachineEvals(seg[2], seg[3])
            return sendJson(res, 200, { success: true })
          }
          if (seg.length === 6) {
            clearMachineEval(seg[2], seg[3], seg[4], seg[5])
            return sendJson(res, 200, { success: true })
          }
        }
      }

      // GET /figure-meta/:stem — subject/type lookup, handy for debugging
      if (method === 'GET' && seg[0] === 'figure-meta' && seg.length === 2) {
        const meta = figureMeta(seg[1])
        if (!meta) return sendJson(res, 404, { error: 'Unknown figure stem.' })
        return sendJson(res, 200, meta)
      }

      return next()
    } catch (err) {
      console.error('[api]', req.method, req.url, err)
      if (res.headersSent) return res.end()
      return sendJson(res, 500, { error: err?.message || 'Internal error' })
    }
  }
}
