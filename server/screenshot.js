/**
 * screenshot.js — headless rendering of a figure's HTML to a base64 JPEG.
 *
 * Trimmed from visionbook/figure-platform/backend/runtime-helpers.js: only the
 * screenshot path is kept (the verifier's renderAndDiagnose has no counterpart
 * here). Screenshots feed the pairwise evaluator's faithfulness and labels
 * dimensions.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import puppeteer from 'puppeteer'

let _browser = null
let _browserProfileDir = null
let _screenshotQueue = Promise.resolve()

function cleanupBrowserProfile() {
  if (!_browserProfileDir) return
  const dir = _browserProfileDir
  _browserProfileDir = null
  fs.rm(dir, { recursive: true, force: true }, () => { })
}

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browserProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figure-benchmark-puppeteer-'))
    _browser = await puppeteer.launch({
      headless: 'new',
      userDataDir: _browserProfileDir,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Software-rendered WebGL for headless. The ANGLE→SwiftShader backend is the
        // combo that actually yields a WebGL2 context on modern Chrome; the older
        // '--disable-gpu --use-gl=swiftshader' pairing fails to create a context
        // ("BindToCurrentSequence failed"), which silently blanks every 3D figure.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--disable-restore-session-state',
      ],
    })
    _browser.on('disconnected', () => {
      _browser = null
      cleanupBrowserProfile()
    })
  }
  return _browser
}

export async function closeScreenshotBrowser() {
  if (_browser) {
    await _browser.close().catch(() => { })
    _browser = null
  }
  cleanupBrowserProfile()
}

async function screenshotHtmlOnce(html, waitMs = 3500) {
  // Detect if the figure uses ES module imports (Three.js CDN) — needs longer wait
  const isModule = html.includes('type="module"') || html.includes("type='module'")
  const effectiveWait = isModule ? Math.max(waitMs, 4000) : waitMs

  let page
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    // Bounded, module-friendly load: the 'load' event is a reliable module-ready
    // signal, and a nav timeout still lets us capture the frame instead of
    // returning null — a slow CDN shouldn't lose the evaluator its screenshot.
    try {
      await page.setContent(html, { waitUntil: isModule ? 'load' : 'domcontentloaded', timeout: 20000 })
    } catch (e) {
      if (!/timeout/i.test(String(e?.message || e))) throw e
    }
    await page.waitForFunction(() => !!document.querySelector('canvas, svg'), { timeout: 6000 }).catch(() => { })
    await new Promise(r => setTimeout(r, effectiveWait))
    const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 82 })
    return { data: shot, mediaType: 'image/jpeg' }
  } catch (err) {
    console.warn('[screenshot] failed:', err.message)
    if (/Target closed|Session closed|Protocol error|browser has disconnected/i.test(err.message || '')) {
      await closeScreenshotBrowser()
    }
    return null
  } finally {
    if (page) await page.close().catch(() => { })
  }
}

/**
 * Render `html` headlessly and return { data: <base64 jpeg>, mediaType } or null.
 * Calls are serialized through a queue — one page at a time keeps memory bounded
 * and avoids SwiftShader contention between concurrent 3D figures.
 */
export async function screenshotHtml(html, waitMs = 3500) {
  const run = () => screenshotHtmlOnce(html, waitMs)
  const queued = _screenshotQueue.then(run, run)
  _screenshotQueue = queued.catch(() => { })
  return queued
}
