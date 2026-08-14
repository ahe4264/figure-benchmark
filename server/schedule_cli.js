/**
 * schedule_cli.js — plan, inspect, and run the sparse comparison schedule.
 *
 *   node server/schedule_cli.js                 what the plan is and how far it got
 *   node server/schedule_cli.js --plan out.json write the plan out as JSON
 *   node server/schedule_cli.js --run           evaluate everything still outstanding
 *   node server/schedule_cli.js --run --limit 50 --model gpt-5   a costed pilot first
 *
 * The design itself lives in src/lib/schedule.js; this is the part that touches
 * disk and the network.
 *
 * Recovery is the whole point of the --run loop, because a full pass is thousands
 * of model calls and something will fail partway. Three properties make an
 * interrupted run safe to simply re-issue:
 *
 *   1. The plan is deterministic. Rebuilding it after a crash yields byte-identical
 *      work items, so a resumed run continues the same design rather than starting
 *      a differently-balanced one.
 *   2. Progress lives in the results themselves. Outstanding work is derived by
 *      subtracting the judge's results directory from the plan, so there is no run-state file
 *      to go stale, be lost, or disagree with what is actually on disk. Killing the
 *      process at any moment costs at most the requests in flight.
 *   3. Failures are bounded and visible. Each request is retried with backoff,
 *      figures that fail are reported rather than skipped silently, and the closing
 *      report checks the design is still connected and balanced — the two ways a
 *      partial run can quietly produce a wrong ranking rather than an obvious error.
 */

import fs from 'fs'
import path from 'path'
import process from 'process'

import { scanSetups } from './setups.js'
import { resultsDirFor, judgeFor, DEFAULT_JUDGE } from './judges.js'
import { pairKey } from '../src/lib/pairs.js'
import {
  DEFAULT_PASSES,
  buildSchedule,
  jobKey,
  outstandingJobs,
  parseSetupId,
  scheduleReport,
} from '../src/lib/schedule.js'

const DEFAULT_API = 'http://localhost:5173/api'

// ── Arguments ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    run: false,
    plan: null,
    limit: Infinity,
    model: null,
    api: process.env.BENCHMARK_API ?? DEFAULT_API,
    attempts: 3,
    concurrency: 5,
    chunk: 10,
    seed: 'figure-benchmark-v1',
    ablation: true,
    rotation: true,
    passes: DEFAULT_PASSES,
    models: null,
    setups: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--run': opts.run = true; break
      case '--plan': opts.plan = next(); break
      case '--limit': opts.limit = Number(next()); break
      case '--model': opts.model = next(); break
      case '--api': opts.api = next(); break
      case '--attempts': opts.attempts = Number(next()); break
      case '--concurrency': opts.concurrency = Number(next()); break
      case '--chunk': opts.chunk = Number(next()); break
      case '--seed': opts.seed = next(); break
      case '--passes': opts.passes = Number(next()); break
      case '--models': opts.models = String(next()).split(',').map(s => s.trim()).filter(Boolean); break
      case '--setups': opts.setups = String(next()).split(',').map(s => s.trim()).filter(Boolean); break
      case '--no-ablation': opts.ablation = false; break
      case '--no-rotation': opts.rotation = false; break
      case '--help': case '-h': opts.help = true; break
      default:
        console.error(`unknown argument: ${arg}`)
        process.exit(2)
    }
  }
  if (!Number.isFinite(opts.limit) && opts.limit !== Infinity) {
    console.error('--limit needs a number')
    process.exit(2)
  }
  return opts
}

const USAGE = `
Usage: node server/schedule_cli.js [options]

  (no options)      report the plan and how much of it is done
  --run             evaluate everything outstanding, resuming where a previous run stopped
  --plan <file>     write the plan to a JSON file
  --limit <n>       only run the first n outstanding comparisons (pilot runs)
  --model <id>      evaluator model, passed through to the API. Also selects the
                    results directory, so each judge is planned and resumed on
                    its own progress (default ${DEFAULT_JUDGE})
  --api <url>       API base (default ${DEFAULT_API}, or $BENCHMARK_API)
  --attempts <n>    retries per request before giving up (default 3)
  --concurrency <n> requests in flight at once (default 5); raise until the
                    provider rate-limits, lower if it starts returning 429s
  --chunk <n>       figures per request (default 10)
  --seed <s>        changes which figure draws which rotation round
  --passes <n>      rotation rounds per figure (default ${DEFAULT_PASSES}); passes are
                    cumulative, so raising this only adds work to an existing run
  --no-ablation     skip layer A (the within-model pipeline pairs)
  --no-rotation     skip layer B (the round-robin rotation)
  --models <a,b>    restrict to setups for these models, e.g. gpt,gemini
  --setups <a,b>    restrict to these exact setup ids
`.trim()

/**
 * Narrow the run to part of the grid.
 *
 * Scoping happens here, on the setup list, rather than by filtering the finished
 * plan: the rotation is a 1-factorization over whichever setups it is given, so
 * removing setups *before* the schedule is built yields a proper balanced design
 * over the ones that remain, where striking rows out afterwards would leave a
 * lopsided fragment of a design meant for twelve.
 */
function selectSetups(ids, { models, setups }) {
  let selected = ids
  if (setups) {
    const wanted = new Set(setups)
    selected = selected.filter(id => wanted.has(id))
    const missing = setups.filter(s => !ids.includes(s))
    if (missing.length) console.warn(`[schedule] no such setup: ${missing.join(', ')}`)
  }
  if (models) {
    const wanted = new Set(models)
    selected = selected.filter(id => {
      const parsed = parseSetupId(id)
      return parsed && wanted.has(parsed.model)
    })
    const found = new Set(selected.map(id => parseSetupId(id)?.model))
    const missing = models.filter(m => !found.has(m))
    if (missing.length) console.warn(`[schedule] no setups for model: ${missing.join(', ')}`)
  }
  return selected
}

// ── Inputs ────────────────────────────────────────────────────────────────────

/**
 * The figures every setup has, which is what the design can be balanced over.
 * A figure missing from even one setup would leave a hole in the rotation, so it
 * is excluded from the plan and reported rather than silently unbalancing things.
 */
function sharedFigures(setups) {
  const counts = new Map()
  const meta = new Map()
  for (const s of setups) {
    for (const f of s.figures) {
      counts.set(f.stem, (counts.get(f.stem) ?? 0) + 1)
      if (!meta.has(f.stem)) meta.set(f.stem, { stem: f.stem, subject: f.subject, type: f.type })
    }
  }
  const shared = []
  const partial = []
  for (const [stem, n] of counts) {
    if (n === setups.length) shared.push(meta.get(stem))
    else partial.push({ stem, present: n })
  }
  shared.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
  return { shared, partial }
}

/**
 * Comparisons already evaluated, as a Set of jobKeys, read straight from the
 * result files. This is the only progress state there is — see the header.
 *
 * Read from the chosen judge's directory, which is what makes a second judge a
 * second run rather than a continuation of the first: GPT-5.5 sees an empty
 * an empty benchmark_results/gpt5.5/ and plans the whole schedule from scratch, without
 * mistaking Gemini's finished comparisons for its own.
 */
function completedKeys(judge) {
  const done = new Set()
  const dir = resultsDirFor(judge)
  if (!fs.existsSync(dir)) return done
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    let records
    try {
      records = Object.values(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')))
    } catch {
      console.warn(`[schedule] ${file} is not valid JSON — treating its comparisons as not done`)
      continue
    }
    for (const r of records) {
      if (!r?.machineEval || !r.setupA || !r.setupB || !r.figure) continue
      done.add(jobKey({ pair: pairKey(r.setupA, r.setupB), stem: r.figure }))
    }
  }
  return done
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function printReport(report, { schedule, setups, partial }) {
  const pct = report.total ? Math.round((report.done / report.total) * 100) : 0
  const roundRobin = ((setups.length * (setups.length - 1)) / 2) * (schedule.length ? new Set(schedule.map(j => j.stem)).size : 0)

  console.log(`\nSetups            ${setups.length}`)
  console.log(`Figures           ${new Set(schedule.map(j => j.stem)).size} shared by every setup`)
  if (partial.length) {
    console.log(`                  ${partial.length} figure(s) missing from some setup, excluded from the plan:`)
    for (const p of partial.slice(0, 10)) console.log(`                    ${p.stem} (in ${p.present}/${setups.length})`)
    if (partial.length > 10) console.log(`                    …and ${partial.length - 10} more`)
  }
  console.log(`\nPlanned           ${report.total} comparisons` + (roundRobin ? `  (round robin would be ${roundRobin}, ${(roundRobin / report.total).toFixed(1)}× more)` : ''))
  for (const [layer, v] of Object.entries(report.byLayer)) {
    console.log(`  ${layer.padEnd(16)}${String(v.planned).padStart(5)}  done ${v.done}`)
  }
  console.log(`\nDone              ${report.done} / ${report.total}  (${pct}%)`)
  console.log(`Remaining         ${report.remaining}`)
  console.log(`Pairs covered     ${report.pairs.started} started / ${report.pairs.planned} planned`)
  console.log(`Graph connected   ${report.connected ? 'yes' : 'NO'}`)
  if (report.balance) console.log(`Per setup done    min ${report.balance.min}, max ${report.balance.max}`)

  console.log('\nPer setup (done / planned):')
  const width = Math.max(...Object.keys(report.perSetup).map(s => s.length))
  for (const [id, v] of Object.entries(report.perSetup)) {
    console.log(`  ${id.padEnd(width)}  ${String(v.done).padStart(5)} / ${v.planned}`)
  }

  if (report.warnings.length) {
    console.log('\nWarnings:')
    for (const w of report.warnings) console.log(`  ! ${w}`)
  }
  console.log()
}

// ── Running ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Evaluate one chunk of a pair's outstanding figures by streaming the batch route.
 * Per-figure outcomes come back as NDJSON; the route already isolates a failing
 * figure from the rest, so a bad figure costs one comparison rather than the chunk.
 */
async function runChunk(api, setupA, setupB, figures, model) {
  const res = await fetch(`${api}/pairwise/batch-evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      setupA,
      setupB,
      figures: figures.map(f => ({ name: f.stem, subject: f.subject })),
      evalModel: model ?? undefined,
      skipExisting: true, // makes a retry cost nothing for figures already evaluated
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

  const outcome = { ok: 0, skipped: 0, errors: [] }
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.status === 'ok') outcome.ok++
      else if (event.status === 'skipped') outcome.skipped++
      else outcome.errors.push({ stem: event.name, error: event.error })
    }
  }
  return outcome
}

/**
 * Split the outstanding work into evenly-sized single-pair requests.
 *
 * Chunking is about throughput, not tidiness. The 12 ablation pairs carry 100
 * figures each while the rotation pairs carry roughly nine, so handing whole pairs
 * to a worker pool leaves one worker grinding through a 100-figure pair long after
 * the others have run dry. Even chunks keep every worker busy to the end.
 *
 * Splitting a pair across requests is safe precisely because the position
 * counterbalance is computed server-side from the pair's *full* shared figure list
 * rather than from whatever subset a request happens to carry — see
 * positionAssignments() and the note in handleBatchEvaluate.
 */
function chunkJobs(jobs, size) {
  const byPair = new Map()
  for (const job of jobs) {
    if (!byPair.has(job.pair)) byPair.set(job.pair, { setupA: job.setupA, setupB: job.setupB, figures: [] })
    byPair.get(job.pair).figures.push(job)
  }
  const chunks = []
  for (const [pair, batch] of byPair) {
    for (let i = 0; i < batch.figures.length; i += size) {
      chunks.push({ pair, setupA: batch.setupA, setupB: batch.setupB, figures: batch.figures.slice(i, i + size) })
    }
  }
  // Biggest first: a full-size chunk picked up last would set the finish time on
  // its own while every other worker idles.
  return chunks.sort((a, b) => b.figures.length - a.figures.length)
}

async function runSchedule(jobs, opts) {
  const chunks = chunkJobs(jobs, opts.chunk)
  const total = jobs.length
  const workers = Math.max(1, opts.concurrency)

  let stopping = false
  const onSigint = () => {
    if (stopping) process.exit(130)
    stopping = true
    console.log(`\n\nInterrupt received — finishing the ${workers} request(s) in flight, then stopping. Re-run to resume.`)
  }
  process.on('SIGINT', onSigint)

  const failures = []
  let completed = 0
  let done = 0
  let next = 0
  const started = Date.now()

  /** One worker: take the next chunk, evaluate it with retries, repeat. */
  async function worker() {
    for (;;) {
      if (stopping || next >= chunks.length) return
      const chunk = chunks[next++]

      let lastError = null
      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        try {
          const outcome = await runChunk(opts.api, chunk.setupA, chunk.setupB, chunk.figures, opts.model)
          completed += outcome.ok
          for (const e of outcome.errors) failures.push({ pair: chunk.pair, ...e })
          lastError = null
          break
        } catch (err) {
          lastError = err
          // A whole-chunk failure is the transport dying rather than a bad figure:
          // the dev server went away, or the connection dropped. Worth backing off,
          // and skipExisting means the retry only redoes what was actually lost.
          const message = err?.cause?.code === 'ECONNREFUSED'
            ? `cannot reach ${opts.api} — is the dev server running?`
            : err.message
          console.log(`  ! ${chunk.pair}: attempt ${attempt}/${opts.attempts} failed: ${message}`)
          if (attempt < opts.attempts && !stopping) await sleep(2000 * attempt)
        }
      }
      if (lastError) {
        failures.push({ pair: chunk.pair, stem: '(whole chunk)', error: lastError.message })
        console.log(`  ! ${chunk.pair}: giving up on this chunk for this run — re-run to retry it`)
      }

      done += chunk.figures.length
      const elapsed = (Date.now() - started) / 1000
      // Throughput measured on the pool as a whole, which is what the remaining
      // time actually depends on — per-worker latency alone would overstate it.
      const perComparison = completed > 0 ? elapsed / completed : 0
      const eta = perComparison > 0 ? (total - done) * perComparison : 0
      console.log(
        `  ${String(done).padStart(5)}/${total}  ${chunk.pair}` +
        (perComparison ? `  |  ${perComparison.toFixed(1)}s/comparison, ~${formatDuration(eta)} left` : '')
      )
    }
  }

  await Promise.all(Array.from({ length: workers }, worker))

  process.off('SIGINT', onSigint)
  return { completed, failures, stopped: stopping, elapsed: (Date.now() - started) / 1000 }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) return console.log(USAGE)

  // Fail here rather than after building a schedule and firing requests: a
  // mistyped --model would otherwise be discovered one HTTP round trip at a time.
  const judge = opts.model || DEFAULT_JUDGE
  try { judgeFor(judge) }
  catch (err) {
    console.error(err.message)
    process.exit(2)
  }
  console.log(`
Judge             ${judge}`)
  console.log(`Results           ${path.relative(process.cwd(), resultsDirFor(judge)) || '.'}`)

  const allSetups = scanSetups()
  if (allSetups.length < 2) {
    console.error(`Need at least 2 setups under experiments/, found ${allSetups.length}.`)
    process.exit(1)
  }

  // Scope before anything else reads the setup list. The shared-figure
  // intersection in particular has to be taken over the setups actually being
  // compared: a figure missing from some unrelated setup is no reason to drop it
  // from a run that never touches that setup.
  const selected = new Set(selectSetups(allSetups.map(s => s.id), opts))
  const setups = allSetups.filter(s => selected.has(s.id))
  if (setups.length < 2) {
    console.error(`Need at least 2 setups after filtering, got ${setups.length}${setups.length ? `: ${[...selected].join(', ')}` : ''}.`)
    process.exit(1)
  }
  if (setups.length < allSetups.length) {
    console.log(`\nScoped to ${setups.length} of ${allSetups.length} setups: ${setups.map(s => s.id).join(', ')}`)
  }

  const { shared, partial } = sharedFigures(setups)
  if (shared.length === 0) {
    console.error('No figure is present in every selected setup — nothing can be scheduled.')
    process.exit(1)
  }

  const ids = setups.map(s => s.id)
  const schedule = buildSchedule(ids, shared, {
    seed: opts.seed,
    includeAblation: opts.ablation,
    includeRotation: opts.rotation,
    passes: opts.passes,
  })

  if (opts.plan) {
    fs.writeFileSync(opts.plan, JSON.stringify(schedule, null, 2))
    console.log(`Wrote ${schedule.length} planned comparisons to ${opts.plan}`)
  }

  const done = completedKeys(judge)
  printReport(scheduleReport(schedule, done, ids), { schedule, setups, partial })

  if (!opts.run) {
    const remaining = outstandingJobs(schedule, done).length
    if (remaining > 0) console.log(`Run \`node server/schedule_cli.js --run\` to evaluate the ${remaining} outstanding comparisons.\n`)
    return
  }

  let pending = outstandingJobs(schedule, done)
  if (pending.length === 0) {
    console.log('Nothing outstanding — the schedule is complete.\n')
    return
  }
  if (Number.isFinite(opts.limit)) pending = pending.slice(0, opts.limit)

  console.log(`Evaluating ${pending.length} comparisons (~${pending.length * 6} model calls) at ${opts.concurrency}-way concurrency. Ctrl-C is safe: progress is saved per comparison.\n`)
  const { completed, failures, stopped, elapsed } = await runSchedule(pending, opts)

  console.log(`\n${completed} comparisons evaluated${stopped ? ' before stopping' : ''} in ${formatDuration(elapsed)}` +
    (completed ? ` — ${(elapsed / completed).toFixed(1)}s per comparison at ${opts.concurrency}-way concurrency.` : '.'))
  if (failures.length) {
    console.log(`\n${failures.length} failed and are still outstanding:`)
    for (const f of failures.slice(0, 20)) console.log(`  ${f.pair}  ${f.stem}: ${f.error}`)
    if (failures.length > 20) console.log(`  …and ${failures.length - 20} more`)
    console.log('\nRe-run the same command to retry them; anything already evaluated is skipped.')
  }

  // Re-read from disk rather than trusting the counters above, so the closing
  // figure is what the results actually contain.
  printReport(scheduleReport(schedule, completedKeys(judge), ids), { schedule, setups, partial })
  if (failures.length) process.exitCode = 1
}

main().catch(err => {
  console.error(`\n[schedule] ${err?.stack ?? err}`)
  process.exit(1)
})
