import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { syncFiguresManifest } from './server/figures_manifest.js'

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
      const { JUDGES, staticPrefixFor, HUMAN_STATIC_PREFIX } = await import('./src/lib/judges.js')
      const { resultsDirFor, HUMAN_RESULTS_DIR } = await import('./server/judges.js')
      const { pairKey } = await import('./src/lib/pairs.js')

      if (!fs.existsSync(EXPERIMENTS_DIR)) {
        console.warn('[static-export] no experiments/ directory — the Outputs and Benchmark tabs will be empty in this build.')
        writeJson(path.join(apiDir, 'setups.json'), { setups: [] })
        // One empty record set per ranking source, at the paths src/api.js asks for.
        for (const judge of Object.keys(JUDGES)) {
          writeJson(path.join(apiDir, staticPrefixFor(judge), 'ranking-records.json'), [])
        }
        writeJson(path.join(apiDir, HUMAN_STATIC_PREFIX, 'ranking-records.json'), [])
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

      // One file per pair per judge, byte-identical to the source .json. The
      // published layout mirrors benchmark_results/ exactly: one directory per
      // judge, plus the shared human set, and nothing loose at the root.
      /** Copy a result directory into the export, returning its records. */
      const exportResultDir = (srcDir, prefix) => {
        const out = []
        let pairs = 0
        if (!fs.existsSync(srcDir)) return { records: out, pairs }
        for (const file of fs.readdirSync(srcDir)) {
          // Skips a nested judge directory as a side effect, which is the same
          // rule the server reads by.
          if (!file.endsWith('.json')) continue
          const src = path.join(srcDir, file)
          const dest = path.join(apiDir, 'results', prefix, file)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.copyFileSync(src, dest)
          pairs++
          try { out.push(...Object.values(JSON.parse(fs.readFileSync(src, 'utf8')))) }
          catch { console.warn(`[static-export] ${prefix}${file} is not valid JSON — skipped for rankings`) }
        }
        return { records: out, pairs }
      }

      // Human verdicts are judge-independent, so they are exported once and then
      // merged into every judge's ranking records — the same shape the dev API
      // serves, so the browser ranks a deployed build identically.
      const human = exportResultDir(HUMAN_RESULTS_DIR, HUMAN_STATIC_PREFIX)
      const humanByKey = new Map(
        human.records.map(r => [`${pairKey(r.setupA, r.setupB)} ${r.subject}__${r.figure}`, r]),
      )
      // The humans rank as a judge in their own right, so they get a record set
      // of their own rather than being read out of some machine judge's file.
      writeJson(path.join(apiDir, HUMAN_STATIC_PREFIX, 'ranking-records.json'), human.records.map(trimRankingRecord))

      const perJudge = []
      for (const judge of Object.keys(JUDGES)) {
        const prefix = staticPrefixFor(judge)
        const { records: machine, pairs } = exportResultDir(resultsDirFor(judge), prefix)

        const seen = new Set()
        const merged = machine.map(r => {
          const key = `${pairKey(r.setupA, r.setupB)} ${r.subject}__${r.figure}`
          seen.add(key)
          return { ...r, humanEvals: humanByKey.get(key)?.humanEvals ?? [] }
        })
        // A figure judged by a human before this judge ever reached it still
        // belongs in the human ranking.
        for (const [key, r] of humanByKey) if (!seen.has(key)) merged.push({ ...r, machineEval: null })

        // Rankings are computed in the browser from these, so the setup filter and
        // the layer filter keep working with no server. Trimmed to winners — the
        // rationales are megabytes and unused here.
        const records = merged.map(trimRankingRecord)
        writeJson(path.join(apiDir, prefix, 'ranking-records.json'), records)
        perJudge.push(`${judge}: ${pairs} pair files, ${records.length} records`)
      }

      console.log(`[static-export] ${exported.length} setups, ${copied} figures, ${shots} screenshots`)
      for (const line of perJudge) console.log(`[static-export]   ${line}`)
      console.log(`[static-export]   human: ${human.pairs} pair files, ${human.records.length} verdicts`)
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
