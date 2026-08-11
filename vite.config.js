import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

function syncFiguresManifest() {
  const imagesDir = path.resolve(__dirname, 'public/images')
  const manifestPath = path.resolve(__dirname, 'public/figures.json')

  const figures = []
  for (const subject of fs.readdirSync(imagesDir)) {
    const subjectDir = path.join(imagesDir, subject)
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

  fs.writeFileSync(manifestPath, JSON.stringify(figures, null, 2), 'utf8')
  console.log(`[figures] synced ${figures.length} figures to figures.json`)
  return figures.length
}

function figuresManifestPlugin() {
  return {
    name: 'figures-manifest',
    buildStart() { syncFiguresManifest() },
    async configureServer(server) {
      syncFiguresManifest()
      const { invalidateCaches } = await import('./server/contexts.js')
      const resync = () => { syncFiguresManifest(); invalidateCaches() }
      server.watcher.add(path.resolve(__dirname, 'public/images'))
      server.watcher.on('add', f => { if (f.includes('public/images')) resync() })
      server.watcher.on('unlink', f => { if (f.includes('public/images')) resync() })
    },
  }
}

/**
 * Serves the benchmark API (/api/*) from inside the dev server, so the whole
 * app — gallery, pairwise evaluator, and the LLM calls behind it — runs under a
 * single `npm run dev` on one port.
 *
 * The handler is imported lazily: it pulls in puppeteer and the provider SDKs,
 * which a plain `vite build` has no use for. Everything it does runs in Node, so
 * API keys stay server-side (Vite only exposes VITE_-prefixed vars to the client).
 */
function benchmarkApiPlugin() {
  return {
    name: 'benchmark-api',
    async configureServer(server) {
      const { createApiHandler } = await import('./server/api.js')
      server.middlewares.use('/api', createApiHandler())
    },
  }
}

/**
 * Freezes the benchmark data into dist/ so a deployed build (Vercel, `npm run
 * preview`) can still browse experiments, results, and rankings without a server.
 *
 * `configureServer` above never runs for `vite build`, so there is no /api in a
 * production bundle by design: nothing deployed can spend an API call or write to
 * benchmark_results/. This exports what the read paths need — the generated HTML,
 * a setups index with dist-relative paths, one file per evaluated pair, and the
 * trimmed records the browser ranks from. src/api.js reads these when
 * import.meta.env.DEV is false.
 */
function staticExportPlugin() {
  const outDir = path.resolve(__dirname, 'dist')
  const apiDir = path.join(outDir, 'api-static')

  const writeJson = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
  }
  // dist-relative POSIX path, which is what src/urls.js turns into a URL.
  const rel = abs => path.relative(outDir, abs).split(path.sep).join('/')

  return {
    name: 'benchmark-static-export',
    apply: 'build',
    async closeBundle() {
      // Only setups.js and the pure rankings helpers are imported here: pulling in
      // pairwise_evaluator would drag models.js, sharp, and undici into a build
      // that never evaluates anything.
      const { scanSetups, EXPERIMENTS_DIR } = await import('./server/setups.js')
      const { trimRankingRecord } = await import('./src/lib/rankings.js')

      if (!fs.existsSync(EXPERIMENTS_DIR)) {
        console.warn('[static-export] no experiments/ directory — the Outputs and Benchmark tabs will be empty in this build.')
        writeJson(path.join(apiDir, 'setups.json'), { setups: [] })
        writeJson(path.join(apiDir, 'ranking-records.json'), [])
        return
      }

      // Copy the generated HTML plus whatever screenshots/ holds, and rewrite
      // every path to its served location. Figures with no capture keep
      // hasScreenshot: false, and the Outputs tab falls back to the reference
      // image exactly as it does in dev.
      const setups = scanSetups()
      let copied = 0
      let shots = 0
      const exported = setups.map(s => ({
        id: s.id,
        figures: s.figures.map(f => {
          const htmlDest = path.join(outDir, 'experiments', s.id, path.basename(f.htmlPath))
          fs.mkdirSync(path.dirname(htmlDest), { recursive: true })
          fs.copyFileSync(f.htmlPath, htmlDest)
          copied++

          let shotRel = null
          if (f.hasScreenshot && f.screenshotPath) {
            const shotDest = path.join(outDir, 'screenshots', s.id, path.basename(f.screenshotPath))
            fs.mkdirSync(path.dirname(shotDest), { recursive: true })
            fs.copyFileSync(f.screenshotPath, shotDest)
            shotRel = rel(shotDest)
            shots++
          }

          // Reference images are already in public/, which Vite copies verbatim.
          const imageRel = f.imagePath
            ? 'images/' + path.relative(path.resolve(__dirname, 'public/images'), f.imagePath).split(path.sep).join('/')
            : null
          return { ...f, htmlPath: rel(htmlDest), imagePath: imageRel, screenshotPath: shotRel, hasScreenshot: !!shotRel }
        }),
      }))
      writeJson(path.join(apiDir, 'setups.json'), { setups: exported })

      // One file per pair, byte-identical to benchmark_results/<pair>.json.
      const resultsDir = path.resolve(__dirname, 'benchmark_results')
      const allRecords = []
      let pairs = 0
      if (fs.existsSync(resultsDir)) {
        for (const file of fs.readdirSync(resultsDir)) {
          if (!file.endsWith('.json')) continue
          const src = path.join(resultsDir, file)
          fs.mkdirSync(path.join(apiDir, 'results'), { recursive: true })
          fs.copyFileSync(src, path.join(apiDir, 'results', file))
          pairs++
          try { allRecords.push(...Object.values(JSON.parse(fs.readFileSync(src, 'utf8')))) }
          catch { console.warn(`[static-export] ${file} is not valid JSON — skipped for rankings`) }
        }
      }

      // Rankings are computed in the browser from these, so the setup filter keeps
      // working. Trimmed to winners — the rationales are megabytes and unused here.
      const records = allRecords.map(trimRankingRecord)
      writeJson(path.join(apiDir, 'ranking-records.json'), records)

      console.log(`[static-export] ${exported.length} setups, ${copied} figures, ${shots} screenshots, ${pairs} pair files, ${records.length} ranking records`)
    },
  }
}

export default defineConfig({
  plugins: [figuresManifestPlugin(), benchmarkApiPlugin(), staticExportPlugin(), react()],
  // The dep scanner crawls every .html under the root by default, which here means
  // the ~1200 model-generated pages under experiments/. Those are data, not app
  // entries, and the ones with sloppy JS (redeclared consts, and so on) fail the
  // scan and take pre-bundling down with them. Only index.html is an entry.
  optimizeDeps: { entries: ['index.html'] },
})
