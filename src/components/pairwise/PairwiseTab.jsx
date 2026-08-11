import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { styles } from './styles.js'
import {
  DIMENSIONS, DIM_LABELS_SHORT,
  winnerBadgeStyle, shortSetup, sideLabel, htmlUrl,
} from './helpers.js'
import ComparisonViewer from './ComparisonViewer.jsx'
import {
  READ_ONLY, fetchModels, fetchSetups, fetchMatchingFigures, fetchResults, fetchHtml,
  fetchRankings, startBatchEvaluate, clearHumanEval, deleteMachineEval as apiDeleteMachineEval,
} from '../../api.js'
import { useUrlState } from '../../lib/urlState.js'

const PAIRWISE_DEFAULT_EVAL_MODEL = 'gemini-3.1-pro'

/**
 * Pairwise benchmark tab — ported from visionbook/figure-platform's PairwiseTab.
 * A "setup" here is one subfolder of experiments/, and figures are keyed by
 * subject rather than textbook chapter.
 */
export default function PairwiseTab() {
  const [availableModels, setAvailableModels] = useState([])
  const [setups, setSetups] = useState([])
  const [matchingFigures, setMatchingFigures] = useState(null)
  const [evalModel, setEvalModel] = useState(PAIRWISE_DEFAULT_EVAL_MODEL)
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
  //             &rankSrc=human&rankBy=geometry&rankSetups=<a>,<b>
  // The eval model is deliberately absent — it parameterises an action, not a view.
  const { params, setParams } = useUrlState()
  const setupA = params.get('a') || ''
  const setupB = params.get('b') || ''
  const openFigure = params.get('figure')
  const pairReady = !!setupA && !!setupB && setupA !== setupB
  const rankingsDim = params.get('rankBy') || 'overall'
  const rankingsSrc = params.get('rankSrc') || 'machine'

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
    fetchModels().then(models => {
      setAvailableModels(models)
      // Keep the dropdown honest if the registry no longer has the default.
      if (models.length > 0 && !models.some(m => m.id === PAIRWISE_DEFAULT_EVAL_MODEL)) {
        setEvalModel(models[0].id)
      }
    })
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
    fetchResults(setupA, setupB).then(setResults)
  }, [setupA, setupB])

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

  const runMachineEval = useCallback(async () => {
    if (!matchingFigures || matchingFigures.length === 0 || running) return
    setRunning(true)
    setProgress({ done: 0, total: matchingFigures.length, log: [] })

    const res = await startBatchEvaluate({ setupA, setupB, figures: matchingFigures, evalModel })
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
    setRunning(false)
  }, [matchingFigures, setupA, setupB, evalModel, running])

  /**
   * Judging happens on a standalone page in its own tab, so a reviewer can work
   * through the whole pair without this one's tables re-rendering underneath
   * them. Results are picked back up by the focus listener above.
   */
  const openHumanEval = useCallback(() => {
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
      await apiDeleteMachineEval(setupA, setupB, r.subject, r.figure)
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
  }, [setupA, setupB])

  const deleteAllMachineEvals = useCallback(async () => {
    try {
      await apiDeleteMachineEval(setupA, setupB)
      setResults(prev => prev.map(r => ({ ...r, machineEval: null })))
    } catch (err) {
      alert('Delete failed: ' + err.message)
    }
  }, [setupA, setupB])

  const loadRankings = useCallback(async (selection) => {
    setRankingsLoading(true)
    try {
      const data = await fetchRankings(selection)
      if (data.availableSetups) setRankingsAvailableSetups(data.availableSetups)
      setRankings(data)
    } catch (err) {
      alert('Failed to load rankings: ' + err.message)
    } finally {
      setRankingsLoading(false)
    }
  }, [])

  // The panel opens from a link as well as from a click, so the first fetch hangs
  // off it being open rather than off the click. One shot, tracked by a ref: on a
  // failed fetch `rankings` stays null, and keying this on that would retry — and
  // re-alert — forever. The Refresh button covers deliberate refetches.
  const rankingsAutoLoaded = useRef(false)
  useEffect(() => {
    if (!rankingsOpen || rankingsAutoLoaded.current) return
    rankingsAutoLoaded.current = true
    loadRankings(rankingsSelectedSetups)
  }, [rankingsOpen, rankingsSelectedSetups, loadRankings])

  /** Point the ranking at a set of setups and refetch it. */
  const applyRankingSetups = useCallback(next => {
    const isAll = next.length === rankingsAvailableSetups.length
    setParams({ rankSetups: isAll ? null : (next.length === 0 ? 'none' : next.join(',')) }, { replace: true })
    loadRankings(isAll ? null : next)
  }, [rankingsAvailableSetups, setParams, loadRankings])

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
                <div style={styles.pwToggleGroup}>
                  {['machine', 'human'].map(src => (
                    <button key={src}
                      style={{ ...styles.pwToggleBtn, ...(rankingsSrc === src ? styles.pwToggleBtnActive : {}) }}
                      onClick={() => setParams(
                        { rankSrc: src === 'machine' ? null : src, ...(src === 'human' ? { rankBy: null } : {}) },
                        { replace: true },
                      )}>
                      {src.charAt(0).toUpperCase() + src.slice(1)}
                    </button>
                  ))}
                </div>
                <div style={styles.pwToggleGroup}>
                  {['overall', ...DIMENSIONS, 'all'].map(d => {
                    const label = { overall: 'Overall', all: 'All Scores', ...DIM_LABELS_SHORT }[d]
                    const disabled = d !== 'overall' && rankingsSrc === 'human'
                    return (
                      <button key={d}
                        style={{ ...styles.pwToggleBtn, fontSize: 10, padding: '3px 9px', ...(rankingsDim === d ? styles.pwToggleBtnActive : {}), ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
                        disabled={disabled}
                        onClick={() => !disabled && setParams({ rankBy: d === 'overall' ? null : d }, { replace: true })}
                        title={disabled ? 'Human evals only have an overall ranking' : ''}>
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {rankingsLoading ? (
                <div style={styles.pwEmptyMsg}>Loading…</div>
              ) : (() => {
                if (rankingsDim === 'all') {
                  const overallRows = rankings?.[rankingsSrc]?.overall ?? []
                  if (overallRows.length === 0) return <div style={styles.pwEmptyMsg}>No data yet — run machine evaluations first.</div>
                  const dimScores = {}
                  for (const d of DIMENSIONS) {
                    for (const row of (rankings?.[rankingsSrc]?.[d] ?? [])) {
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
                const rows = rankings?.[rankingsSrc]?.[rankingsDim] ?? []
                if (rows.length === 0) return <div style={styles.pwEmptyMsg}>No data yet — run machine evaluations first.</div>
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
              })()}
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
            {!READ_ONLY && (
              <div style={styles.pwStack}>
                <div style={styles.pwLabel}>Eval Model</div>
                <select style={styles.pwSelect} value={evalModel} onChange={e => setEvalModel(e.target.value)}>
                  {availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
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
