/**
 * models.js — model router for the benchmark evaluator.
 *
 * Exposes a single `generateWithModel(modelId, { systemPrompt, userContent, maxTokens })`
 * call. `userContent` is an OpenAI-format content array
 * ([{ type:'text', text }, { type:'image_url', image_url:{ url } }]) — the shape the
 * evaluator builds — which this module converts to Gemini parts.
 *
 * Adapted from visionbook/figure-platform/backend/models.js, narrowed to Gemini
 * 3.1 Pro (the only model this benchmark evaluates with).
 */

import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config({ path: path.join(__dirname, '..', '.env') })

// ── URL-routed fetch patch — Gemini dispatcher ──────────────────────────────
// The @google/genai SDK's ApiClient calls bare `fetch()` (globalThis.fetch)
// directly, ignoring any `fetch` option passed to the GoogleGenAI constructor.
// We therefore patch globalThis.fetch with URL-based routing:
//   • requests to generativelanguage.googleapis.com → undici dispatcher with
//     keepAlive=false (fresh TCP per call, avoids stale-socket UND_ERR_SOCKET)
//     and generous timeouts for long streaming generations.
//   • all other requests → original fetch unchanged.
try {
  const undici = await import('undici')
  const _geminiDispatcher = new undici.Agent({
    connect: { keepAlive: false },  // fresh TCP per request
    headersTimeout: 300_000,        // 5 min — time to first byte
    bodyTimeout: 0,                 // unlimited — stream large responses
  })
  const _origFetch = globalThis.fetch
  globalThis.fetch = (url, opts = {}) => {
    const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url))
    if (urlStr.includes('generativelanguage.googleapis.com') ||
      urlStr.includes('aiplatform.googleapis.com')) {
      return undici.fetch(url, { ...opts, dispatcher: _geminiDispatcher })
    }
    return _origFetch(url, opts)
  }
  console.log('[models] fetch patched: Gemini URLs → undici (keepAlive=false, headersTimeout=5min), others → native')
} catch {
  // undici not available — rely on default fetch with streaming as fallback
}

// ── Lazy-init client ─────────────────────────────────────────────────────────
let _gemini = null
let _googleGenAIClass = null

const GEMINI_MAX_IMAGE_DIMENSION = 2048
const GEMINI_JPEG_QUALITY = 82
const MODEL_CALL_TIMEOUT_MS = Number(process.env.MODEL_CALL_TIMEOUT_MS) || 600_000

function withTimeout(promise, label, timeoutMs = MODEL_CALL_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function withRetry(label, fn, retries = 2, baseDelayMs = 1000) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err?.message || String(err)
      const retryable = /fetch failed|connection error|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|ENOTFOUND|429|503|overloaded|timeout/i.test(msg)
      if (!retryable || attempt >= retries) throw err
      const delay = baseDelayMs * Math.pow(2, attempt)
      console.warn(`[models] ${label} retryable error (attempt ${attempt + 1}/${retries}): ${msg} — retrying in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

async function prepareGeminiImage(url) {
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Gemini adapter: invalid data URL for image')

  const [, , data] = match
  const input = Buffer.from(data, 'base64')

  const output = await sharp(input)
    .rotate()
    .resize({
      width: GEMINI_MAX_IMAGE_DIMENSION,
      height: GEMINI_MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: GEMINI_JPEG_QUALITY, mozjpeg: true })
    .toBuffer()

  return {
    inlineData: {
      mimeType: 'image/jpeg',
      data: output.toString('base64'),
    },
  }
}

async function getGemini() {
  if (!_gemini) {
    const key = process.env.GOOGLE_API_KEY
    if (!key || key === 'your_google_api_key_here')
      throw new Error('GOOGLE_API_KEY is not set. Add it to .env')
    if (!_googleGenAIClass) {
      ({ GoogleGenAI: _googleGenAIClass } = await import('@google/genai'))
    }
    // fetch option is NOT forwarded by @google/genai's ApiClient — it uses
    // globalThis.fetch directly. The URL-based fetch patch at module load time
    // handles the dispatcher routing without needing a custom fetch here.
    _gemini = new _googleGenAIClass({ apiKey: key })
  }
  return _gemini
}

// ── Model registry ───────────────────────────────────────────────────────────
// Each entry: { provider, apiModel, label }
//   apiModel — the exact string sent to the API
//   label    — human-readable name shown in the UI
export const MODEL_REGISTRY = {
  'gemini-3.1-pro': { provider: 'google', apiModel: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
}

export const DEFAULT_MODEL_ID = 'gemini-3.1-pro'

// The list the frontend renders in its eval-model dropdown
export function getAvailableModels() {
  return Object.entries(MODEL_REGISTRY).map(([id, { label, provider }]) => ({
    id, label, provider,
  }))
}

/**
 * Gemini call — uses streaming to avoid the ~60 s HTTP connection timeout that
 * Google imposes on non-streaming generateContent requests. With
 * generateContentStream, tokens arrive immediately and we accumulate them.
 */
async function callGemini(apiModel, systemPrompt, userContent, maxTokens) {
  const client = await getGemini()

  const parts = await Promise.all(userContent.map(async block => {
    if (block.type === 'image_url') {
      return prepareGeminiImage(block.image_url.url)
    }
    return { text: block.text }
  }))
  const contents = [{ role: 'user', parts }]

  return withTimeout((async () => {
    try {
      const stream = await client.models.generateContentStream({
        model: apiModel,
        contents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: maxTokens,
        },
      })

      let text = ''
      for await (const chunk of stream) {
        text += chunk.text ?? ''
      }
      return text
    } catch (err) {
      const cause = err.cause
      console.error(`[Gemini] ${apiModel} call failed: ${err.message}` +
        (cause ? ` | cause: ${cause.code || ''} ${cause.message || ''}` : ''))
      throw err
    }
  })(), `${apiModel} call`)
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * @param {string} modelId — key in MODEL_REGISTRY
 * @param {object} opts
 * @param {string} opts.systemPrompt — the full system prompt
 * @param {Array}  opts.userContent  — OpenAI-format content array
 *                                     [{ type:'image_url', image_url:{url} }, { type:'text', text }]
 * @param {number} [opts.maxTokens]  — max output tokens (default 16384)
 * @returns {Promise<string>} raw text from the model
 */
export async function generateWithModel(modelId, { systemPrompt, userContent, maxTokens = 16384 }) {
  const entry = MODEL_REGISTRY[modelId]
  if (!entry) throw new Error(`Unknown model: "${modelId}". Available: ${Object.keys(MODEL_REGISTRY).join(', ')}`)

  return withRetry(modelId, () => callGemini(entry.apiModel, systemPrompt, userContent, maxTokens))
}
