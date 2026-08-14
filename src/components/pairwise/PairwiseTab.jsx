import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { styles } from './styles.js'
import {
  DIMENSIONS, DIM_LABELS_SHORT,
  winnerBadgeStyle, shortSetup, sideLabel, htmlUrl,
} from './helpers.js'
import ComparisonViewer from './ComparisonViewer.jsx'
import {
  READ_ONLY, fetchJudges, fetchRankingSources, fetchSetups, fetchMatchingFigures, fetchResults, fetchHtml,
  fetchRankings, startBatchEvaluate, clearHumanEval, deleteMachineEval as apiDeleteMachineEval,
} from '../../api.js'
import { DEFAULT_JUDGE, isHumanSource } from '../../lib/judges.js'
import { LAYERS } from '../../lib/rankings.js'
import { useUrlState } from '../../lib/urlState.js'

/**
 * Figures per batch-evaluate request. Matches schedule_cli's --chunk default, so
 * a run started from the UI is diced the same way as one started from the CLI
 * and the two are interchangeable on the same result set.
 */
const EVAL_CHUNK_SIZE = 10

/**
 * Requests in flight at once — NOT the number of concurrent model calls.
 *
 * Each request walks its figures one at a time, but every figure fans out to five
 * parallel dimension agents, so the peak load on the provider is roughly
 * concurrency x 5. A measured 25-way burst (concurrency 5) against GPT-5.5 used
 * about 6% of a 4M-token-per-minute budget and drew no rate limiting, which is
 * where the default comes from.
 */
const CONCURRENCY_CHOICES = [1, 2, 3, 5, 8, 10]
const DEFAULT_CONCURRENCY = 5

const LAYER_LABELS = { all: 'All', ablation: 'Ablation', rotation: 'Rotation' }
const LAYER_TITLES = {
  all: 'Every comparison in the design',
  ablation: 'Layer A only — pipelines within one model. Says nothing about the models: no two models ever meet here.',
  rotation: 'Layer B only — the cross-model round robin. The only evidence that compares models.',
}

/**
 * Pairwise benchmark tab — ported from visionbook/figure-platform's PairwiseTab.
 * A "setup" here is one subfolder of experiments/, and figures are keyed by
 * subject rather than textbook chapter.
 */
export default function PairwiseTab() {
  const [availableJudgeList, setAvailableJudgeList] = useState([])
  const [rankingSourceList, setRankingSourceList] = useState([])
  const [setups, setSetups] = useState([])
  const [matchingFigures, setMatchingFigures] = useState(null)
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, log: [] })
  const [results, setResults] = useState([])
  const [rankings, setRankings] = useState(null)
  const [rankingsLoading, setRankingsLoading] = useState(false)
  const [rankingsAvailableSetups, setRankingsAvailableSetups] = useState([])
  const [compViewerHtmlA, setCompViewerHtmlA] = useState(null)
  const [compViewerHtmlB, setCompViewerHtmlB] = useState(null)
  const [compViewerLoading, setCompViewerLoading] = useState(false)

  // Everything a link should restore lives in the hash:
  //   #benchmark?a=<setup>&b=<setup>&figure=11.3&panels=rankings,machine
  //             &rankJudge=human&rankBy=geometry&rankSetups=<a>,<b>
  //             &judge=gpt-5.5&rankLayer=ablation
  // Concurrency is deliberately absent — it parameterises an action, not a view.
  const { params, setParams } = useUrlState()
  const setupA = params.get('a') || ''
  const setupB = params.get('b') || ''
  const openFigure = params.get('figure')
  const pairReady = !!setupA && !!setupB && setupA !== setupB
  const rankingsDim = params.get('rankBy') || 'overall'
  const rankingsLayer = LAYERS.includes(params.get('rankLayer')) ? params.get('rankLayer') : 'all'

  // Whose verdicts the ranking is fitted over — a machine judge, or the humans.
  // Independent of `judge` below on purpose: that one says which result set the
  // pair tables show and where a run writes, this one says who is being ranked,
  // and wanting to rank GPT's verdicts while looking at Gemini's pair table is a
  // perfectly ordinary thing to want.
  const rankingsJudge = params.get('rankJudge') || DEFAULT_JUDGE
  const rankingIsHuman = isHumanSource(rankingsJudge)
  // A human verdict is a single choice with no per-dimension breakdown, so a
  // dimension left in the URL from a machine judge falls back rather than
  // rendering an empty table.
  const rankingEffectiveDim = rankingIsHuman ? 'overall' : rankingsDim

  // The judge belongs in the URL where the eval model did not: it selects which
  // result set is on screen, not just what a click would do. Picking one both
  // shows that judge's verdicts and sends new runs to its folder, because those
  // are the same choice — a run you cannot then look at would be a bug.
  const judge = params.get('judge') || DEFAULT_JUDGE

  const openPanels = useMemo(
    () => new Set((params.get('panels') || '').split(',').filter(Boolean)),
    [params],
  )
  const rankingsOpen = openPanels.has('rankings')
  const machineTableOpen = openPanels.has('machine')
  const humanTableOpen = openPanels.has('human')

  const togglePanel = useCallback(name => {
    const next = new Set(openPanels)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setParams({ panels: [...next].join(',') }, { replace: true })
  }, [openPanels, setParams])

  // null means every setup, so the ordinary case stays out of the URL entirely.
  // "none" is the literal for having deselected them all: an empty value would
  // just be dropped, and would come back as "every setup" instead.
  const rankSetupsParam = params.get('rankSetups')
  const rankingsSelectedSetups = useMemo(() => {
    if (rankSetupsParam === null) return null
    return rankSetupsParam === 'none' ? [] : rankSetupsParam.split(',').filter(Boolean)
  }, [rankSetupsParam])
  const rankingsSelection = rankingsSelectedSetups ?? rankingsAvailableSetups

  const sortedMatchingFigures = useMemo(() => {
    if (!matchingFigures) return []
    return [...matchingFigures].sort((a, b) => {
      const c = a.subject.localeCompare(b.subject)
      return c !== 0 ? c : a.name.localeCompare(b.name)
    })
  }, [matchingFigures])

  useEffect(() => {
    fetchJudges().then(setAvailableJudgeList)
    fetchRankingSources().then(setRankingSourceList)
  }, [])

  useEffect(() => {
    fetchSetups().then(setSetups)
  }, [])

  useEffect(() => {
    if (!setupA || !setupB || setupA === setupB) { setMatchingFigures(null); return }
    fetchMatchingFigures(setupA, setupB).then(setMatchingFigures)
  }, [setupA, setupB])

  const reloadResults = useCallback(() => {
    if (!setupA || !setupB || setupA === setupB) { setResults([]); return }
    fetchResults(setupA, setupB, judge).then(setResults)
  }, [setupA, setupB, judge])

  useEffect(() => { reloadResults() }, [reloadResults])

  // Human evaluation happens in a separate browser tab, so pick up whatever it
  // recorded when this tab comes back to the foreground.
  useEffect(() => {
    if (READ_ONLY) return
    const onFocus = () => { if (!document.hidden) reloadResults() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [reloadResults])

  // The URL names the open figure rather than its position, so a link survives a
  // re-sort, and switching setups closes a viewer whose figure is no longer in
  // the join instead of silently showing a different one.
  const compViewerFigIndex = useMemo(() => {
    if (!openFigure) return null
    const i = sortedMatchingFigures.findIndex(f => f.name === openFigure)
    return i >= 0 ? i : null
  }, [openFigure, sortedMatchingFigures])

  useEffect(() => {
    if (compViewerFigIndex === null) return
    const fig = sortedMatchingFigures[compViewerFigIndex]
    if (!fig) return
    let cancelled = false
    setCompViewerLoading(true)
    setCompViewerHtmlA(null)
    setCompViewerHtmlB(null)
    Promise.all([
      fetchHtml(htmlUrl(fig.htmlPathA)),
      fetchHtml(htmlUrl(fig.htmlPathB)),
    ]).then(([htmlA, htmlB]) => {
      if (!cancelled) { setCompViewerHtmlA(htmlA); setCompViewerHtmlB(htmlB); setCompViewerLoading(false) }
    })
    return () => { cancelled = true }
  }, [compViewerFigIndex, sortedMatchingFigures])

  /** Stream one batch-evaluate request, folding each NDJSON line into progress. */
  const consumeChunk = useCallback(async (figures) => {
    const res = await startBatchEvaluate({ setupA, setupB, figures, evalModel: judge })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          const icon = parsed.status === 'ok' ? '✓' : parsed.status === 'skipped' ? '⏭' : '✗'
          setProgress(p => ({
            done: p.done + 1,
            total: p.total,
            log: [...p.log, `${icon} ${parsed.subject}/${parsed.name}${parsed.status === 'skipped' ? ' (skipped)' : ''}${parsed.status === 'error' ? ` — ${parsed.error}` : ''}`],
          }))
          if (parsed.status === 'ok' && parsed.result) {
            setResults(prev => {
              const idx = prev.findIndex(r => r.subject === parsed.subject && r.figure === parsed.name)
              const updated = { setupA, setupB, subject: parsed.subject, figure: parsed.name, machineEval: parsed.result, humanEvals: [] }
              if (idx >= 0) { const next = [...prev]; next[idx] = { ...prev[idx], machineEval: parsed.result }; return next }
              return [...prev, updated]
            })
          }
        } catch { /* malformed line */ }
      }
    }
  }, [setupA, setupB, judge])

  /**
   * Run the whole pair, `concurrency` requests at a time.
   *
   * The same worker-pool shape as schedule_cli: figures are cut into fixed-size
   * requests and a fixed number of workers pull from the queue, so the last
   * worker is never left grinding alone on an oversized chunk. Splitting a pair
   * across requests is safe because the server counterbalances positions from the
   * pair's *full* shared figure list rather than from whatever subset a request
   * happens to carry — see positionAssignments() and handleBatchEvaluate.
   *
   * A failed request costs its own chunk and nothing else: its figures are counted
   * off so the bar still completes, and re-running skips whatever already landed.
   */
  const runMachineEval = useCallback(async () => {
    if (!matchingFigures || matchingFigures.length === 0 || running) return
    setRunning(true)
    setProgress({ done: 0, total: matchingFigures.length, log: [] })

    const chunks = []
    for (let i = 0; i < matchingFigures.length; i += EVAL_CHUNK_SIZE) {
      chunks.push(matchingFigures.slice(i, i + EVAL_CHUNK_SIZE))
    }

    // Workers share this cursor. `next++` is safe without a lock: there is no
    // await between reading it and incrementing it, so a worker cannot be
    // suspended midway and hand a second worker the same chunk.
    let next = 0
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]
        try {
          await consumeChunk(chunk)
        } catch (err) {
          setProgress(p => ({
            done: p.done + chunk.length,
            total: p.total,
            log: [...p.log, `✗ ${chunk.length} figure(s) failed — ${err.message}`],
          }))
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
    } finally {
      setRunning(false)
    }
  }, [matchingFigures, running, concurrency, consumeChunk])

  /**
   * Judging happens on a standalone page in its own tab, so a reviewer can work
   * through the whole pair without this one's tables re-rendering underneath
   * them. Results are picked back up by the focus listener above.
   */
  const openHumanEval = useCallback(() => {
    // No judge in the link: human verdicts are shared across judges, so the
    // judging page has only one result set it could be adding to.
    const qs = `setupA=${encodeURIComponent(setupA)}&setupB=${encodeURIComponent(setupB)}`
    window.open(`${window.location.pathname}#human-eval?${qs}`, '_blank', 'noopener')
  }, [setupA, setupB])

  const clearHumanEvals = useCallback(async (r) => {
    try {
      await clearHumanEval({ setupA, setupB, subject: r.subject, figure: r.figure })
      setResults(prev => {
        const idx = prev.findIndex(x => x.subject === r.subject && x.figure === r.figure)
        if (idx < 0) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], humanEvals: [] }
        return updated
      })
    } catch (err) {
      alert('Clear failed: ' + err.message)
    }
  }, [setupA, setupB])

  const deleteMachineEval = useCallback(async (r) => {
    try {
      await apiDeleteMachineEval(setupA, setupB, r.subject, r.figure, judge)
      setResults(prev => {
        const idx = prev.findIndex(x => x.subject === r.subject && x.figure === r.figure)
        if (idx < 0) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], machineEval: null }
        return updated
      })
    } catch (err) {
      alert('Delete failed: ' + err.message)
    }
  }, [setupA, setupB, judge])

  const deleteAllMachineEvals = useCallback(async () => {
    try {
      await apiDeleteMachineEval(setupA, setupB, null, null, judge)
      setResults(prev => prev.map(r => ({ ...r, machineEval: null })))
    } catch (err) {
      alert('Delete failed: ' + err.message)
    }
  }, [setupA, setupB, judge])

  const loadRankings = useCallback(async (selection) => {
    setRankingsLoading(true)
    try {
      const data = await fetchRankings(selection, { judge: rankingsJudge, layer: rankingsLayer })
      if (data.availableSetups) setRankingsAvailableSetups(data.availableSetups)
      setRankings(data)
    } catch (err) {
      alert('Failed to load rankings: ' + err.message)
    } finally {
      setRankingsLoading(false)
    }
  }, [rankingsJudge, rankingsLayer])

  // The panel opens from a link as well as from a click, so the first fetch hangs
  // off it being open rather than off the click. One shot, tracked by a ref: on a
  // failed fetch `rankings` stays null, and keying this on that would retry — and
  // re-alert — forever. The Refresh button covers deliberate refetches.
  //
  // Changing the judge or the layer changes which table is being asked for, so
  // the ref holds the last combination fetched rather than a bare boolean: a new
  // combination refetches once, the same one does not. Setting it before the
  // fetch is what keeps a failure from looping.
  const rankingsAutoLoaded = useRef('')
  useEffect(() => {
    if (!rankingsOpen) return
    const key = `${rankingsJudge}|${rankingsLayer}`
    if (rankingsAutoLoaded.current === key) return
    rankingsAutoLoaded.current = key
    loadRankings(rankingsSelectedSetups)
  }, [rankingsOpen, rankingsJudge, rankingsLayer, rankingsSelectedSetups, loadRankings])

  /** Point the ranking at a set of setups and refetch it. */
  const applyRankingSetups = useCallback(next => {
    const isAll = next.length === rankingsAvailableSetups.length
    setParams({ rankSetups: isAll ? null : (next.length === 0 ? 'none' : next.join(',')) }, { replace: true })
    loadRankings(isAll ? null : next)
  }, [rankingsAvailableSetups, setParams, loadRankings])

  // One table for most views; one per experiment model under Ablation, where the
  // comparison graph is four disconnected pieces — see src/lib/rankings.js.
  const rankingGroups = rankings?.groups ?? []
  // A source with no verdicts still comes back as one empty group, so "is there
  // anything to show" is a question about rows, not about groups.
  const rankingHasRows = rankingGroups.some(g => (g.ranking?.overall ?? []).length > 0)

  const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  // Merge matchingFigures (all pairs) with stored results, so figures that have
  // not been evaluated yet still get a row
  const mergedRows = useMemo(() => {
    if (!matchingFigures) return results
    const resultMap = new Map(results.map(r => [`${r.subject}__${r.figure}`, r]))
    return sortedMatchingFigures.map(f => {
      const key = `${f.subject}__${f.name}`
      return resultMap.get(key) || { figure: f.name, subject: f.subject, humanEvals: [] }
    })
  }, [matchingFigures, sortedMatchingFigures, results])

  // Tallies for the strip at the top of each results card. Computed here rather
  // than inside the tables because they stay on screen when a card is collapsed.
  const machineSummary = useMemo(() => {
    const scored = mergedRows.filter(r => r.machineEval?.aggregator)
    return [
      { label: 'Evaluated', text: `${scored.length} / ${mergedRows.length}` },
      ...DIMENSIONS.map(d => ({
        label: DIM_LABELS_SHORT[d],
        ...tally(mergedRows, r => r.machineEval?.dimensions?.[d]?.winner, setupA, setupB),
      })),
      { label: 'Overall', ...tally(mergedRows, r => r.machineEval?.aggregator?.winner, setupA, setupB) },
    ]
  }, [mergedRows, setupA, setupB])

  const humanSummary = useMemo(() => {
    const judged = mergedRows.filter(r => (r.humanEvals || []).length > 0)
    return [
      { label: 'Judged', text: `${judged.length} / ${mergedRows.length}` },
      { label: 'Winner', ...tally(mergedRows, r => (r.humanEvals || [])[0]?.winner, setupA, setupB) },
    ]
  }, [mergedRows, setupA, setupB])

  const compViewerResult = useMemo(() => {
    if (compViewerFigIndex === null) return null
    const fig = sortedMatchingFigures[compViewerFigIndex]
    if (!fig) return null
    return results.find(r => r.figure === fig.name && r.subject === fig.subject) ?? null
  }, [compViewerFigIndex, sortedMatchingFigures, results])

  // A shared link names its figure before the join has loaded. Hold here rather
  // than flashing the tables for the moment before the viewer can resolve it —
  // but only while a pair is actually selected, since matchingFigures stays null
  // forever otherwise and a link carrying just a figure would hang on this.
  if (openFigure && pairReady && matchingFigures === null) {
    return <div style={styles.pwEmptyMsg}>Loading comparison…</div>
  }

  return (
    compViewerFigIndex !== null ? (
      <ComparisonViewer
        figure={sortedMatchingFigures[compViewerFigIndex]}
        result={compViewerResult}
        setupA={setupA}
        setupB={setupB}
        htmlA={compViewerHtmlA}
        htmlB={compViewerHtmlB}
        loading={compViewerLoading}
        figureIndex={compViewerFigIndex}
        totalFigures={sortedMatchingFigures.length}
        onBack={() => setParams({ figure: null }, { replace: true })}
        onPrev={() => setParams({ figure: sortedMatchingFigures[compViewerFigIndex - 1]?.name }, { replace: true })}
        onNext={() => setParams({ figure: sortedMatchingFigures[compViewerFigIndex + 1]?.name }, { replace: true })}
      />
    ) : (
      <div style={styles.pwRoot}>
        {/* Panel 1 — Rankings (Bradley-Terry) */}
        <div style={styles.pwCard}>
          <div style={{ ...styles.pwCardTitle, cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            onClick={() => togglePanel('rankings')}>
            <span>{rankingsOpen ? '▾' : '▸'} Rankings (Bradley-Terry)</span>
            {rankingsOpen && (
              <button style={styles.pwLinkBtn}
                onClick={e => { e.stopPropagation(); loadRankings(rankingsSelectedSetups) }}>↻ Refresh</button>
            )}
          </div>
          {rankingsOpen && (
            <div>
              {rankingsAvailableSetups.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>Setups</span>
                    <button style={{ fontSize: 10, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      onClick={() => {
                        const allSelected = rankingsSelection.length === rankingsAvailableSetups.length
                        applyRankingSetups(allSelected ? [] : [...rankingsAvailableSetups])
                      }}>
                      {rankingsSelection.length === rankingsAvailableSetups.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                    {rankingsAvailableSetups.map(s => {
                      const checked = rankingsSelection.includes(s)
                      return (
                        <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked} onChange={() => {
                            applyRankingSetups(checked
                              ? rankingsSelection.filter(x => x !== s)
                              : [...rankingsSelection, s])
                          }} />
                          {s}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                {/* Which layer of the design to rank over. The two answer
                    different questions — see LAYERS in src/lib/rankings.js — so
                    this sits alongside the source and dimension toggles rather
                    than being buried as an option. */}
                <div style={styles.pwToggleGroup}>
                  {LAYERS.map(l => (
                    <button key={l}
                      style={{ ...styles.pwToggleBtn, ...(rankingsLayer === l ? styles.pwToggleBtnActive : {}) }}
                      title={LAYER_TITLES[l]}
                      onClick={() => setParams({ rankLayer: l === 'all' ? null : l }, { replace: true })}>
                      {LAYER_LABELS[l]}
                    </button>
                  ))}
                </div>
                {/* Who is being ranked. The humans are one of the options rather
                    than a separate axis, because a ranking is a fit over one set
                    of verdicts and theirs is one such set. Independent of the
                    Judge dropdown below, which controls the pair tables. */}
                <div style={styles.pwToggleGroup}>
                  {rankingSourceList.map(src => (
                    <button key={src.id}
                      style={{ ...styles.pwToggleBtn, ...(rankingsJudge === src.id ? styles.pwToggleBtnActive : {}) }}
                      title={src.kind === 'human'
                        ? 'Rank by human verdicts, which are shared across judges'
                        : `Rank by ${src.label}'s verdicts`}
                      onClick={() => setParams(
                        {
                          rankJudge: src.id === DEFAULT_JUDGE ? null : src.id,
                          // Dimensions do not exist for human verdicts, so drop a
                          // stale one rather than leaving it dangling in the URL.
                          ...(src.kind === 'human' ? { rankBy: null } : {}),
                        },
                        { replace: true },
                      )}>
                      {src.label}
                    </button>
                  ))}
                </div>
                <div style={styles.pwToggleGroup}>
                  {['overall', ...DIMENSIONS, 'all'].map(d => {
                    const label = { overall: 'Overall', all: 'All Scores', ...DIM_LABELS_SHORT }[d]
                    const disabled = d !== 'overall' && rankingIsHuman
                    return (
                      <button key={d}
                        style={{ ...styles.pwToggleBtn, fontSize: 10, padding: '3px 9px', ...(rankingsDim === d ? styles.pwToggleBtnActive : {}), ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
                        disabled={disabled}
                        onClick={() => !disabled && setParams({ rankBy: d === 'overall' ? null : d }, { replace: true })}
                        title={disabled ? 'Human verdicts are a single choice, with no per-dimension ranking' : ''}>
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {rankingsLoading ? (
                <div style={styles.pwEmptyMsg}>Loading…</div>
              ) : !rankingHasRows ? (
                <div style={styles.pwEmptyMsg}>
                  {rankingsLayer === 'ablation'
                    ? 'No ablation comparisons for this judge yet.'
                    : rankingIsHuman
                      ? 'No human evaluations yet — judge some figures first.'
                      : 'No data yet — run machine evaluations first.'}
                </div>
              ) : (
                <>
                  {/* The reason the split exists, said once rather than per table. */}
                  {rankingGroups.length > 1 && (
                    <div style={{ ...styles.pwEmptyMsg, textAlign: 'left', marginBottom: 10 }}>
                      One table per experiment model. Layer A never puts two models against
                      each other, so scores are comparable within a table and not across them.
                    </div>
                  )}
                  {rankingGroups.map(g => (
                    <div key={g.key} style={{ marginBottom: rankingGroups.length > 1 ? 20 : 0 }}>
                      {g.label && (
                        <div style={{ ...styles.pwLabel, marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span>{g.label}</span>
                          {!g.connected && (
                            <span
                              style={{ color: 'var(--danger)', fontWeight: 600 }}
                              title="This model's comparisons form more than one disconnected group, so its scores are not all on one scale. Run the outstanding comparisons for this model.">
                              incomplete
                            </span>
                          )}
                        </div>
                      )}
                      <RankingTable ranking={g.ranking} dim={rankingEffectiveDim} />
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Panel 2 — Setup Selector */}
        <div style={styles.pwCard}>
          <div style={styles.pwCardTitle}>Compare Experiment Setups</div>
          <div style={styles.pwRow}>
            <div style={styles.pwStack}>
              <div style={styles.pwLabel}>Setup A</div>
              <select style={styles.pwSelect} value={setupA} onChange={e => setParams({ a: e.target.value, figure: null }, { replace: true })}>
                <option value=''>— select —</option>
                {setups.map(s => <option key={s.id} value={s.id}>{s.id} ({s.figures.length})</option>)}
              </select>
            </div>
            <div style={styles.pwStack}>
              <div style={styles.pwLabel}>Setup B</div>
              <select style={styles.pwSelect} value={setupB} onChange={e => setParams({ b: e.target.value, figure: null }, { replace: true })}>
                <option value=''>— select —</option>
                {setups.filter(s => s.id !== setupA).map(s => <option key={s.id} value={s.id}>{s.id} ({s.figures.length})</option>)}
              </select>
            </div>
            {/* One control, because it is one choice: the judge whose verdicts
                are on screen is also the judge a new run would add to. Shown in
                read-only builds too — a deployed site cannot run anything, but it
                can still browse either judge's finished results. */}
            <div style={styles.pwStack}>
              <div style={styles.pwLabel}>Judge</div>
              <select
                style={styles.pwSelect}
                value={judge}
                disabled={running}
                title={running ? 'Finish or stop the current run before switching judge' : "Each judge keeps its own result set; switching swaps the whole table"}
                onChange={e => setParams({ judge: e.target.value === DEFAULT_JUDGE ? null : e.target.value }, { replace: true })}>
                {availableJudgeList.map(j => <option key={j.id} value={j.id}>{j.label}</option>)}
              </select>
            </div>
            {!READ_ONLY && (
              <div style={styles.pwStack}>
                <div style={styles.pwLabel}>Concurrency</div>
                <select
                  style={styles.pwSelect}
                  value={concurrency}
                  disabled={running}
                  title={`Requests in flight at once. Each carries ${EVAL_CHUNK_SIZE} figures and every figure fans out to 5 dimension agents, so peak model calls is about ${concurrency * 5}.`}
                  onChange={e => setConcurrency(Number(e.target.value))}>
                  {CONCURRENCY_CHOICES.map(n => (
                    <option key={n} value={n}>{n}{n === DEFAULT_CONCURRENCY ? ' (default)' : ''}</option>
                  ))}
                </select>
              </div>
            )}
            {!READ_ONLY && (
              // Full-width so the pair always wraps onto its own line together,
              // rather than one button trailing the selects and the other alone.
              <div style={styles.pwActionRow}>
                <button
                  style={{ ...styles.pwRunBtn, ...(!matchingFigures || matchingFigures.length === 0 || running ? styles.pwRunBtnDisabled : {}) }}
                  disabled={!matchingFigures || matchingFigures.length === 0 || running}
                  onClick={runMachineEval}
                >
                  {running ? 'Running…' : 'Run Machine Evaluation'}
                </button>
                <button
                  style={{ ...styles.pwOpenBtn, ...(pairReady ? {} : styles.pwOpenBtnDisabled) }}
                  disabled={!pairReady}
                  onClick={openHumanEval}
                  title={pairReady
                    ? 'Judge every figure in this pair, in a new tab'
                    : 'Pick two different experiments first'}>
                  Open Human Evaluation ↗
                </button>
              </div>
            )}
          </div>
          {(running || progress.done > 0) && progress.total > 0 && (
            <div style={styles.pwProgress}>
              <div style={styles.pwProgressBar}>
                <div style={{ ...styles.pwProgressFill, width: `${progressPct}%` }} />
              </div>
              <div style={styles.pwProgressLog}>
                {progress.log.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}
        </div>

        {/* Panel 3 — Machine Results Table */}
        {pairReady && (
          <div style={styles.pwCard}>
            <div style={{ ...styles.pwCardTitle, cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => togglePanel('machine')}>
              <span>{machineTableOpen ? '▾' : '▸'} Machine Results — {shortSetup(setupA)} vs {shortSetup(setupB)}</span>
              {!READ_ONLY && (
                <button style={styles.pwDangerLinkBtn}
                  onClick={e => { e.stopPropagation(); deleteAllMachineEvals() }}>Delete All</button>
              )}
            </div>
            {mergedRows.length > 0 && <SummaryStrip items={machineSummary} />}
            {machineTableOpen && (mergedRows.length === 0 ? (
              <div style={styles.pwEmptyMsg}>Select two setups with overlapping figures to begin.</div>
            ) : (
              <table style={{ ...styles.pwTable, tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ ...styles.pwTh, width: '25%' }}>Figure</th>
                    {DIMENSIONS.map(d => <th key={d} style={{ ...styles.pwTh, width: '10%' }}>{DIM_LABELS_SHORT[d]}</th>)}
                    <th style={{ ...styles.pwTh, width: '15%' }}>Overall</th>
                    <th style={{ ...styles.pwTh, width: '7%' }}>Conf</th>
                    <th style={{ ...styles.pwTh, width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {mergedRows.map(r => {
                    const me = r.machineEval
                    return (
                      <tr key={`${r.subject}__${r.figure}__machine`}>
                        <td style={styles.pwTd}>
                          <div style={{ fontWeight: 600 }}>{r.figure}</div>
                          <div style={styles.pwSubtle}>{r.subject}</div>
                        </td>
                        {DIMENSIONS.map(d => (
                          <td key={d} style={styles.pwTd}>
                            {me?.dimensions?.[d]
                              ? <span style={winnerBadgeStyle(me.dimensions[d].winner, setupA, setupB)} title={me.dimensions[d].rationale}>
                                {sideLabel(me.dimensions[d].winner, setupA, setupB)}
                              </span>
                              : <span style={styles.pwMuted}>—</span>}
                          </td>
                        ))}
                        <td style={styles.pwTd}>
                          {me?.aggregator
                            ? <span style={winnerBadgeStyle(me.aggregator.winner, setupA, setupB)} title={me.aggregator.explanation}>
                              {sideLabel(me.aggregator.winner, setupA, setupB)}
                            </span>
                            : <span style={styles.pwMuted}>—</span>}
                        </td>
                        <td style={styles.pwTd}>{me?.aggregator ? (me.aggregator.confidence * 100).toFixed(0) + '%' : '—'}</td>
                        <td style={styles.pwTd}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <button
                              style={styles.pwAddBtn}
                              onClick={() => setParams({ figure: r.figure })}
                            >View</button>
                            {me && !READ_ONLY && (
                              <button
                                style={{ ...styles.pwDeleteBtn, padding: '2px 6px' }}
                                onClick={() => deleteMachineEval(r)}
                                title="Delete machine eval"
                              >×</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ))}
          </div>
        )}

        {/* Panel 4 — Human Results Table */}
        {pairReady && (
          <div style={styles.pwCard}>
            <div style={{ ...styles.pwCardTitle, cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
              onClick={() => togglePanel('human')}>
              <span>{humanTableOpen ? '▾' : '▸'} Human Results — {shortSetup(setupA)} vs {shortSetup(setupB)}</span>
            </div>
            {mergedRows.length > 0 && <SummaryStrip items={humanSummary} />}
            {humanTableOpen && (mergedRows.length === 0 ? (
              <div style={styles.pwEmptyMsg}>Select two setups with overlapping figures to begin.</div>
            ) : (
              <table style={styles.pwTable}>
                <thead>
                  <tr>
                    <th style={{ ...styles.pwTh, width: '40%' }}>Figure</th>
                    <th style={{ ...styles.pwTh, width: '10%' }}>Winner</th>
                    <th style={{ ...styles.pwTh, width: '40%' }}>Notes</th>
                    <th style={{ ...styles.pwTh, width: '10%' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {mergedRows.map(r => {
                    const he = (r.humanEvals || [])[0]
                    return (
                      <tr key={`${r.subject}__${r.figure}`}>
                        <td style={styles.pwTd}>
                          <div style={{ fontWeight: 600 }}>{r.figure}</div>
                          <div style={styles.pwSubtle}>{r.subject}</div>
                        </td>
                        <td style={styles.pwTd}>
                          {he
                            ? <span style={winnerBadgeStyle(he.winner, setupA, setupB)}>{sideLabel(he.winner, setupA, setupB)}</span>
                            : <span style={styles.pwMuted}>—</span>}
                        </td>
                        <td style={{ ...styles.pwTd, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {he?.notes || ''}
                        </td>
                        <td style={styles.pwTd}>
                          {he && !READ_ONLY && (
                            <button
                              style={styles.pwDeleteBtn}
                              onClick={() => clearHumanEvals(r)}
                              title='Delete human evaluation'
                            >Delete</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ))}
          </div>
        )}
      </div>
    )
  )
}

/**
 * Wins for each side under `winnerOf`, ignoring rows that have no verdict yet.
 * `n` is how many rows counted, so an untouched dimension can read as "—"
 * rather than as three zeroes.
 */
function tally(rows, winnerOf, setupA, setupB) {
  let a = 0, b = 0, tie = 0
  for (const r of rows) {
    const w = winnerOf(r)
    if (w === setupA) a++
    else if (w === setupB) b++
    else if (w === 'tie') tie++
  }
  return { a, b, tie, n: a + b + tie }
}


/**
 * One Bradley-Terry table.
 *
 * Rendered once for most views and once per experiment model under Ablation,
 * where the comparison graph is four disconnected pieces and a single combined
 * table would put scores side by side that no comparison ever produced — see
 * groupRecords in src/lib/rankings.js.
 *
 * `dim` is 'all' for the every-dimension matrix, otherwise 'overall' or one
 * dimension. A human ranking has only 'overall', which the caller resolves
 * before it gets here.
 */
function RankingTable({ ranking, dim }) {
  if (dim === 'all') {
    const overallRows = ranking?.overall ?? []
    if (overallRows.length === 0) return <div style={styles.pwEmptyMsg}>No data yet.</div>
    const dimScores = {}
    for (const d of DIMENSIONS) {
      for (const row of (ranking?.[d] ?? [])) {
        if (!dimScores[row.id]) dimScores[row.id] = {}
        dimScores[row.id][d] = row.score
      }
    }
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ ...styles.pwTable, tableLayout: 'auto', minWidth: 480 }}>
          <thead>
            <tr>
              <th style={{ ...styles.pwTh, width: 28 }}>#</th>
              <th style={styles.pwTh}>Setup</th>
              <th style={{ ...styles.pwTh, textAlign: 'right' }}>Overall</th>
              {DIMENSIONS.map(d => (
                <th key={d} style={{ ...styles.pwTh, textAlign: 'right' }}>{DIM_LABELS_SHORT[d]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {overallRows.map((row, i) => (
              <tr key={row.id}>
                <td style={{ ...styles.pwTd, fontWeight: 700, color: i === 0 ? 'var(--accent)' : 'var(--text-faint)', fontSize: 11 }}>{i + 1}</td>
                <td style={styles.pwTd}>
                  <div style={{ fontWeight: 600, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.id}>{row.id}</div>
                </td>
                <td style={{ ...styles.pwTd, textAlign: 'right', fontWeight: 700, color: 'var(--accent)', fontSize: 11 }}>{(row.score * 100).toFixed(1)}</td>
                {DIMENSIONS.map(d => {
                  const s = dimScores[row.id]?.[d]
                  return (
                    <td key={d} style={{ ...styles.pwTd, textAlign: 'right', fontSize: 11, color: s != null ? 'var(--text)' : 'var(--text-faint)' }}>
                      {s != null ? (s * 100).toFixed(1) : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const rows = ranking?.[dim] ?? []
  if (rows.length === 0) return <div style={styles.pwEmptyMsg}>No data yet.</div>
  const maxScore = rows[0]?.score ?? 1
  return (
    <table style={{ ...styles.pwTable, tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{ ...styles.pwTh, width: 32 }}>#</th>
          <th style={styles.pwTh}>Setup</th>
          <th style={{ ...styles.pwTh, width: '22%' }}>BT Score</th>
          <th style={{ ...styles.pwTh, width: 40 }}>W</th>
          <th style={{ ...styles.pwTh, width: 40 }}>L</th>
          <th style={{ ...styles.pwTh, width: 40 }}>T</th>
          <th style={{ ...styles.pwTh, width: 40 }}>N</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.id}>
            <td style={{ ...styles.pwTd, fontWeight: 700, color: i === 0 ? 'var(--accent)' : 'var(--text-faint)', fontSize: 12 }}>{i + 1}</td>
            <td style={styles.pwTd}>
              <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.id}>{row.id}</div>
            </td>
            <td style={styles.pwTd}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 6, background: 'var(--accent-track)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(row.score / maxScore) * 100}%`, background: 'var(--accent)', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 34, textAlign: 'right', flexShrink: 0 }}>{(row.score * 100).toFixed(1)}</span>
              </div>
            </td>
            <td style={{ ...styles.pwTd, color: 'var(--badge-b-text)', fontWeight: 600, fontSize: 11 }}>{row.wins}</td>
            <td style={{ ...styles.pwTd, color: 'var(--danger)', fontWeight: 600, fontSize: 11 }}>{row.losses}</td>
            <td style={{ ...styles.pwTd, color: 'var(--badge-tie-text)', fontSize: 11 }}>{row.ties}</td>
            <td style={{ ...styles.pwTd, color: 'var(--text-faint)', fontSize: 11 }}>{row.comparisons}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The A/B/tie counts that used to sit in each table's <tfoot>. Up here they are
 * readable without scrolling past every figure, and they survive collapsing the
 * card — which is why each item carries its own label rather than borrowing
 * meaning from the column it sits under.
 */
function SummaryStrip({ items }) {
  return (
    <div style={styles.pwSummaryStrip}>
      {items.map(it => (
        <div key={it.label} style={styles.pwSummaryItem}>
          <span style={styles.pwSummaryLabel}>{it.label}</span>
          <span style={styles.pwSummaryCounts}>
            {'text' in it
              ? it.text
              : it.n === 0
                ? <span style={styles.pwMuted}>—</span>
                : <>
                  <span style={{ color: 'var(--badge-a-text)' }}>A:{it.a}</span>{' · '}
                  <span style={{ color: 'var(--badge-b-text)' }}>B:{it.b}</span>
                  {it.tie > 0 && <>{' · '}<span style={{ color: 'var(--badge-tie-text)' }}>T:{it.tie}</span></>}
                </>}
          </span>
        </div>
      ))}
    </div>
  )
}
