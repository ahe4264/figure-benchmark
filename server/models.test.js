/**
 * models.test.js — the OpenAI adapter's request and response handling.
 *
 * fetch is stubbed rather than called, so these run offline and for free. What
 * they pin down is the handful of details that a live probe showed the GPT-5
 * reasoning family actually cares about, and which a plain read of the OpenAI
 * docs would get wrong: the budget parameter's name, and the fact that running
 * out of budget arrives as a successful response with nothing in it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateWithModel, MODEL_REGISTRY, getAvailableModels } from './models.js'

const ARGS = {
  systemPrompt: 'You are a strict evaluator.',
  userContent: [
    { type: 'text', text: 'Figure 1 source code:\n\n<html></html>' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
  ],
  maxTokens: 4096,
}

/** Swap in a fake fetch for one call, capturing what the adapter sent. */
async function withStubbedFetch(respond, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts, body: JSON.parse(opts.body) })
    return respond(calls.length)
  }
  process.env.OPENAI_API_KEY = 'sk-test-key'
  try { return { result: await fn(), calls } }
  finally { globalThis.fetch = original }
}

const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const VERDICT = '{"winner":"1","confidence":0.9,"rationale":"Figure 1 is cleaner."}'

test('gpt-5.5 is registered as an openai model', () => {
  assert.equal(MODEL_REGISTRY['gpt-5.5'].provider, 'openai')
  assert.ok(getAvailableModels().some(m => m.id === 'gpt-5.5'))
})

test('a successful call returns the message content', async () => {
  const { result } = await withStubbedFetch(
    () => ok({ choices: [{ message: { content: VERDICT }, finish_reason: 'stop' }], usage: {} }),
    () => generateWithModel('gpt-5.5', ARGS),
  )
  assert.equal(result, VERDICT)
})

test('the budget is sent as max_completion_tokens — max_tokens is rejected by these models', async () => {
  const { calls } = await withStubbedFetch(
    () => ok({ choices: [{ message: { content: VERDICT } }], usage: {} }),
    () => generateWithModel('gpt-5.5', ARGS),
  )
  assert.equal(calls[0].body.max_completion_tokens, 4096)
  assert.ok(!('max_tokens' in calls[0].body), 'max_tokens must not be sent')
})

test('the dated snapshot is what gets sent, not the friendly id', async () => {
  const { calls } = await withStubbedFetch(
    () => ok({ choices: [{ message: { content: VERDICT } }], usage: {} }),
    () => generateWithModel('gpt-5.5', ARGS),
  )
  assert.equal(calls[0].body.model, MODEL_REGISTRY['gpt-5.5'].apiModel)
  assert.match(calls[0].body.model, /^gpt-5\.5-\d{4}-\d{2}-\d{2}$/)
})

/**
 * The evaluator builds content in OpenAI's own format, so the adapter's job is
 * to not touch it. A conversion creeping in here would quietly drop the images.
 */
test('system prompt and content array are passed through unchanged', async () => {
  const { calls } = await withStubbedFetch(
    () => ok({ choices: [{ message: { content: VERDICT } }], usage: {} }),
    () => generateWithModel('gpt-5.5', ARGS),
  )
  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: ARGS.systemPrompt },
    { role: 'user', content: ARGS.userContent },
  ])
  assert.match(calls[0].opts.headers.Authorization, /^Bearer sk-test-key$/)
})

/**
 * The failure mode that cost the most to diagnose: HTTP 200, finish_reason
 * "length", and an empty string where the JSON verdict should be, because
 * reasoning spent the whole budget. It must not reach the JSON parser as a
 * mysterious empty response.
 */
test('empty content is reported as a budget problem, not a parse problem', async () => {
  await assert.rejects(
    () => withStubbedFetch(
      () => ok({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } },
      }),
      () => generateWithModel('gpt-5.5', ARGS),
    ),
    err => {
      assert.match(err.message, /empty content/i)
      assert.match(err.message, /finish_reason=length/)
      assert.match(err.message, /reasoning_tokens=4096/)
      assert.match(err.message, /PAIRWISE_MAX_TOKENS/)
      return true
    },
  )
})

test('a non-retryable HTTP error surfaces the status and body', async () => {
  await assert.rejects(
    () => withStubbedFetch(
      () => new Response('{"error":{"message":"unsupported parameter"}}', { status: 400, statusText: 'Bad Request' }),
      () => generateWithModel('gpt-5.5', ARGS),
    ),
    err => {
      assert.match(err.message, /HTTP 400/)
      assert.match(err.message, /unsupported parameter/)
      return true
    },
  )
})

test('an unknown model id names the ones that exist', async () => {
  await assert.rejects(
    () => generateWithModel('gpt-9', ARGS),
    /Unknown model: "gpt-9".*gemini-3\.1-pro.*gpt-5\.5/s,
  )
})
