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
import { availableJudges, judgeFor, rankingSources, rankingSourceFor, DEFAULT_JUDGE } from './judges.js'
import { scanSetups, matchingFigures, EXPERIMENTS_DIR, SCREENSHOTS_DIR } from './setups.js'
import { screenshotHtml } from './screenshot.js'
import { buildRankings, LAYERS } from '../src/lib/rankings.js'
import { positionAssignments } from '../src/lib/schedule.js'
import {
  pairwiseEvaluateFigure,
  loadPairwiseResult,
  savePairwiseResult,
  loadAllPairwiseResults,
  loadAllPairsForRanking,
  loadAllHumanForRanking,
  loadHumanResult,
  saveHumanResult,
  loadAllHumanResults,
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

/**
 * Which judge's result set a request is talking about.
 *
 * Reads are addressed by an explicit `judge`; writes derive it from the model
 * doing the evaluating, so the verdicts of a run can only ever land in the
 * folder belonging to the model that produced them. An unknown value throws
 * (see judges.js) and the router turns that into a 400 rather than quietly
 * writing into the default judge's finished results.
 */
function resolveJudge(value) {
  const id = value || DEFAULT_JUDGE
  judgeFor(id) // throws on an unknown id
  return id
}

/** Layer of the design to rank over; anything unrecognised is a 400. */
function resolveLayer(value) {
  const layer = value || 'all'
  if (!LAYERS.includes(layer)) throw new Error(`unknown layer: "${value}". Known layers: ${LAYERS.join(', ')}`)
  return layer
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

  // The evaluating model decides where its verdicts go — there is no separate
  // destination to set, so a run cannot be pointed at another judge's results.
  let judge
  try { judge = resolveJudge(evalModel) }
  catch (err) { return sendJson(res, 400, { error: err.message }) }

  // Re-derive the figure paths server-side rather than trusting the request body,
  // so a crafted htmlPath can't pull a file from outside experiments/.
  const allFigures = matchingFigures(setupA, setupB)
  const trusted = new Map(allFigures.map(f => [f.name, f]))

  // Counterbalanced over every figure the two setups share, not just the subset
  // this request asks for — so a run split across several requests, or resumed
  // after a failure, still seats each side first on half the figures. Deriving it
  // from the full list is what makes that hold regardless of how the work is diced.
  const positions = positionAssignments(setupA, setupB, allFigures)

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
        const existing = loadPairwiseResult(setupA, setupB, subject, name, judge)
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
        positions: positions.get(name) ?? null,
      })

      // Human verdicts live in their own folder now, so there is nothing to
      // preserve here — only this judge's own record is being rewritten.
      const existing = loadPairwiseResult(setupA, setupB, subject, name, judge) || { setupA, setupB, subject, figure: name }
      savePairwiseResult(setupA, setupB, subject, name, { ...existing, machineEval: evalResult }, judge)

      res.write(JSON.stringify({ name, subject, status: 'ok', result: evalResult }) + '\n')
    } catch (err) {
      console.error(`[pairwise] eval error for ${subject}/${name}:`, err?.message || err)
      res.write(JSON.stringify({ name, subject, status: 'error', error: err?.message || 'Evaluation failed.' }) + '\n')
    }
  }

  res.end()
}

/**
 * A ranking is a fit over one judge's verdicts, and here the humans count as a
 * judge: `?judge=human` ranks the shared human result set, anything else ranks
 * that machine judge's own directory. Nothing is merged — mixing two judges'
 * verdicts into one Bradley-Terry fit ranks neither of them.
 */
function handleRankings(res, url) {
  const setupsParam = url.searchParams.get('setups')
  const allowed = setupsParam !== null ? setupsParam.split(',').filter(Boolean) : null
  const layer = resolveLayer(url.searchParams.get('layer'))
  const { id, kind } = rankingSourceFor(url.searchParams.get('judge'))

  const records = kind === 'human' ? loadAllHumanForRanking() : loadAllPairsForRanking(id)
  return sendJson(res, 200, buildRankings(records, allowed, { layer, source: kind }))
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

      // GET /judges — the models that have a result set of their own. The UI
      // uses this rather than /models so every option it offers is one that can
      // both be run and be read back.
      if (method === 'GET' && seg[0] === 'judges' && seg.length === 1) {
        return sendJson(res, 200, availableJudges())
      }

      // GET /ranking-sources — the judges a ranking can be built from, which is
      // every machine judge plus the humans. A superset of /judges: you can rank
      // by human verdicts, but you cannot run an evaluation with them.
      if (method === 'GET' && seg[0] === 'ranking-sources' && seg.length === 1) {
        return sendJson(res, 200, rankingSources())
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
          return sendJson(res, 200, loadAllPairwiseResults(seg[2], seg[3], resolveJudge(url.searchParams.get('judge'))))
        }

        // GET /pairwise/human-results/:setupA/:setupB — the judging page's own
        // read. Deliberately not the merged view: it only needs to know which
        // figures are already judged, and a judge's rationales are megabytes.
        if (method === 'GET' && seg[1] === 'human-results' && seg.length === 4) {
          return sendJson(res, 200, loadAllHumanResults(seg[2], seg[3]))
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
          // No judge here on purpose: a human verdict is the ground truth every
          // judge is scored against, so there is one of it, in one place.
          const { setupA, setupB, subject, figure, winner, notes } = await readBody(req)
          if (!setupA || !setupB || !subject || !figure)
            return sendJson(res, 400, { error: 'setupA, setupB, subject, figure are required.' })

          if (method === 'DELETE') {
            saveHumanResult(setupA, setupB, subject, figure, [])
            return sendJson(res, 200, { success: true })
          }

          if (!winner) return sendJson(res, 400, { error: 'winner is required.' })
          const existing = loadHumanResult(setupA, setupB, subject, figure)
          const humanEval = { winner, notes: notes || '', submittedAt: new Date().toISOString() }
          saveHumanResult(setupA, setupB, subject, figure, [...(existing?.humanEvals || []), humanEval])
          return sendJson(res, 200, { success: true, humanEval })
        }

        // DELETE /pairwise/machine-eval/:setupA/:setupB[/:subject/:figure]
        if (method === 'DELETE' && seg[1] === 'machine-eval') {
          const judge = resolveJudge(url.searchParams.get('judge'))
          if (seg.length === 4) {
            clearAllMachineEvals(seg[2], seg[3], judge)
            return sendJson(res, 200, { success: true })
          }
          if (seg.length === 6) {
            clearMachineEval(seg[2], seg[3], seg[4], seg[5], judge)
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
      // A bad judge or layer is the caller's mistake, not the server's.
      const status = /^unknown (judge|layer)/i.test(err?.message || '') ? 400 : 500
      return sendJson(res, status, { error: err?.message || 'Internal error' })
    }
  }
}
