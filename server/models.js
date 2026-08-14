/**
 * models.js — model router for the benchmark evaluator.
 *
 * Exposes a single `generateWithModel(modelId, { systemPrompt, userContent, maxTokens })`
 * call. `userContent` is an OpenAI-format content array
 * ([{ type:'text', text }, { type:'image_url', image_url:{ url } }]) — the shape the
 * evaluator builds — which this module converts to Gemini parts.
 *
 * Adapted from visionbook/figure-platform/backend/models.js. Gemini 3.1 Pro was
 * the only judge for the first runs; GPT-5.5 was added as a second one so the two
 * can be compared against each other (their verdicts are kept in separate result
 * directories — see server/judges.js).
 *
 * The OpenAI adapter speaks HTTP directly rather than pulling in the `openai`
 * package. The evaluator already builds content in OpenAI's own format, so the
 * SDK would earn nothing here but a dependency — it is Gemini that needs the
 * conversion, not GPT.
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

// ── Retry policy ──────────────────────────────────────────────────────────────
// Two failure modes need different waits, and treating them alike is what made a
// batch run shed most of its work. A 503 "high demand" clears in seconds. A 429
// quota error does not clear until the provider's rate window rolls over, so the
// old policy — two attempts, 1s then 2s — spent both retries inside the very
// window that was already exhausted and then gave up. Over one 20-comparison run
// that produced 267 rate-limit errors and lost 14 of the 20 comparisons.
const RETRY_MAX_ATTEMPTS = Number(process.env.MODEL_RETRY_ATTEMPTS) || 6
const RETRY_BASE_DELAY_MS = Number(process.env.MODEL_RETRY_BASE_MS) || 1_000
const RETRY_MAX_DELAY_MS = Number(process.env.MODEL_RETRY_MAX_MS) || 64_000
/** A 429 waits at least this long: anything shorter re-enters the same window. */
const RETRY_QUOTA_FLOOR_MS = Number(process.env.MODEL_RETRY_QUOTA_FLOOR_MS) || 20_000

const RETRYABLE = /fetch failed|connection error|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|ENOTFOUND|429|500|503|overloaded|timeout|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL/i
const QUOTA = /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i

/**
 * The provider's own advice, when it gives any.
 *
 * Gemini attaches a RetryInfo detail — `"retryDelay": "37s"` — to some quota
 * errors, and it knows when the window rolls over better than any backoff curve
 * can guess. The error surfaces here as a JSON string rather than a response
 * object, so it is read back out of the message.
 */
function providerRetryDelayMs(message) {
  const retryInfo = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i)
  if (retryInfo) return Math.round(Number(retryInfo[1]) * 1000)
  const retryAfter = message.match(/retry-after"?\s*[:=]\s*"?(\d+)/i)
  if (retryAfter) return Number(retryAfter[1]) * 1000
  return null
}

function withTimeout(promise, label, timeoutMs = MODEL_CALL_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function withRetry(label, fn, retries = RETRY_MAX_ATTEMPTS, baseDelayMs = RETRY_BASE_DELAY_MS) {
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err?.message || String(err)
      if (!RETRYABLE.test(msg) || attempt >= retries) throw err

      const quota = QUOTA.test(msg)
      const exponential = Math.min(RETRY_MAX_DELAY_MS, baseDelayMs * Math.pow(2, attempt))
      const target = quota ? Math.max(RETRY_QUOTA_FLOOR_MS, exponential) : exponential

      // Equal jitter. Several evaluations run in parallel and a quota error hits
      // all of them at once, so a fixed curve would march them back into the API
      // in lockstep and re-trip the same limit. Half the wait is deterministic so
      // the backoff still grows; half is random so the herd spreads out.
      const jittered = Math.round(target / 2 + Math.random() * (target / 2))
      const delay = providerRetryDelayMs(msg) ?? jittered

      const kind = quota ? 'rate limit' : 'transient error'
      console.warn(
        `[models] ${label} ${kind} (attempt ${attempt + 1}/${retries}, ${Math.round((Date.now() - started) / 1000)}s elapsed) ` +
        `— retrying in ${(delay / 1000).toFixed(1)}s: ${msg.slice(0, 160)}`
      )
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

// ── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY
  if (!key || key === 'your_openai_api_key_here')
    throw new Error('OPENAI_API_KEY is not set. Add it to .env')
  return key
}

/**
 * OpenAI chat-completions call.
 *
 * `userContent` is passed through untouched — it is already in OpenAI's content
 * format, which is the format the evaluator builds.
 *
 * Two details are specific to the GPT-5 reasoning family and both were confirmed
 * against the live API rather than assumed:
 *
 *   • the token budget is `max_completion_tokens`; `max_tokens` is rejected
 *     outright on these models.
 *   • the budget covers *reasoning* as well as the reply, and reasoning takes the
 *     larger share — a measured 26.6k of 28.4k completion tokens over 25 calls.
 *     So a budget large enough for the JSON verdict is not necessarily large
 *     enough to reach it, and running out shows up as a 200 response carrying
 *     empty content rather than as an error.
 */
async function callOpenAI(apiModel, systemPrompt, userContent, maxTokens) {
  const key = getOpenAIKey()

  return withTimeout((async () => {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: apiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: maxTokens,
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // The status code has to appear in the message text: withRetry classifies
      // retryable failures by matching the message, not by inspecting a response.
      const err = new Error(`OpenAI ${apiModel} HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 400)}`)
      console.error(`[OpenAI] ${err.message}`)
      throw err
    }

    const body = await res.json()
    const choice = body.choices?.[0]
    const text = choice?.message?.content ?? ''

    if (!text.trim()) {
      // Distinguishing this from a parse failure is the difference between a
      // one-line budget change and hunting a phantom formatting bug upstream.
      const usage = body.usage ?? {}
      throw new Error(
        `OpenAI ${apiModel} returned empty content (finish_reason=${choice?.finish_reason ?? 'unknown'}, ` +
        `reasoning_tokens=${usage.completion_tokens_details?.reasoning_tokens ?? '?'}/` +
        `${usage.completion_tokens ?? '?'} completion) — reasoning consumed the budget; raise PAIRWISE_MAX_TOKENS.`
      )
    }

    return text
  })(), `${apiModel} call`)
}

// ── Model registry ───────────────────────────────────────────────────────────
// Each entry: { provider, apiModel, label }
//   apiModel — the exact string sent to the API
//   label    — human-readable name shown in the UI
export const MODEL_REGISTRY = {
  'gemini-3.1-pro': { provider: 'google', apiModel: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  // Pinned to the dated snapshot deliberately: a judge that silently changes
  // underneath a half-finished run would make the early and late comparisons
  // incomparable, and the whole ranking rests on them being one judge.
  'gpt-5.5': { provider: 'openai', apiModel: 'gpt-5.5-2026-04-23', label: 'GPT-5.5' },
}

const PROVIDERS = {
  google: callGemini,
  openai: callOpenAI,
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

  const call = PROVIDERS[entry.provider]
  if (!call) throw new Error(`Model "${modelId}" names an unknown provider: "${entry.provider}".`)

  return withRetry(modelId, () => call(entry.apiModel, systemPrompt, userContent, maxTokens))
}
