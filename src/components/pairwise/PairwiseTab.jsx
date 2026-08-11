import { useState, useEffect, useMemo, useCallback } from 'react'
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

const PAIRWISE_DEFAULT_EVAL_MODEL = 'gemini-3.1-pro'

/**
 * Pairwise benchmark tab — ported from visionbook/figure-platform's PairwiseTab.
 * A "setup" here is one subfolder of experiments/, and figures are keyed by
 * subject rather than textbook chapter.
 */
export default function PairwiseTab() {
  const [availableModels, setAvailableModels] = useState([])
  const [setups, setSetups] = useState([])
  const [setupA, setSetupA] = useState('')
  const [setupB, setSetupB] = useState('')
  const [matchingFigures, setMatchingFigures] = useState(null)
  const [evalModel, setEvalModel] = useState(PAIRWISE_DEFAULT_EVAL_MODEL)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, log: [] })
  const [results, setResults] = useState([])
  const [machineTableOpen, setMachineTableOpen] = useState(false)
  const [humanTableOpen, setHumanTableOpen] = useState(false)
  const [rankingsOpen, setRankingsOpen] = useState(false)
  const [rankings, setRankings] = useState(null)
  const [rankingsDim, setRankingsDim] = useState('overall')
  const [rankingsSrc, setRankingsSrc] = useState('machine')
  const [rankingsLoading, setRankingsLoading] = useState(false)
  const [rankingsAvailableSetups, setRankingsAvailableSetups] = useState([])
  const [rankingsSelectedSetups, setRankingsSelectedSetups] = useState(() => {
    try { const s = localStorage.getItem('rankingsSelectedSetups'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const [compViewerFigIndex, setCompViewerFigIndex] = useState(null)
  const [compViewerHtmlA, setCompViewerHtmlA] = useState(null)
  const [compViewerHtmlB, setCompViewerHtmlB] = useState(null)
  const [compViewerLoading, setCompViewerLoading] = useState(false)

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

  useEffect(() => {
    setCompViewerFigIndex(null)
  }, [setupA, setupB])

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
      if (data.availableSetups) {
        setRankingsAvailableSetups(data.availableSetups)
        setRankingsSelectedSetups(prev => prev === null ? data.availableSetups : prev)
      }
      setRankings(data)
    } catch (err) {
      alert('Failed to load rankings: ' + err.message)
    } finally {
      setRankingsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (rankingsSelectedSetups !== null) {
      try { localStorage.setItem('rankingsSelectedSetups', JSON.stringify(rankingsSelectedSetups)) } catch { /* quota */ }
    }
  }, [rankingsSelectedSetups])

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

  const compViewerResult = useMemo(() => {
    if (compViewerFigIndex === null) return null
    const fig = sortedMatchingFigures[compViewerFigIndex]
    if (!fig) return null
    return results.find(r => r.figure === fig.name && r.subject === fig.subject) ?? null
  }, [compViewerFigIndex, sortedMatchingFigures, results])

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
        onBack={() => setCompViewerFigIndex(null)}
        onPrev={() => setCompViewerFigIndex(i => Math.max(0, i - 1))}
        onNext={() => setCompViewerFigIndex(i => Math.min(sortedMatchingFigures.length - 1, i + 1))}
      />
    ) : (
      <div style={styles.pwRoot}>
        {!READ_ONLY && setupA && setupB && setupA !== setupB && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -12 }}>
            <button style={styles.pwOpenBtn}
              onClick={openHumanEval}
              title="Judge every figure in this pair, in a new tab">
              Open Human Evaluation ↗
            </button>
          </div>
        )}

        {/* Panel 1 — Rankings (Bradley-Terry) */}
        <div style={styles.pwCard}>
          <div style={{ ...styles.pwCardTitle, cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            onClick={() => {
              const next = !rankingsOpen
              setRankingsOpen(next)
              if (next && !rankings) loadRankings(rankingsSelectedSetups)
            }}>
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
                        const allSelected = rankingsSelectedSetups?.length === rankingsAvailableSetups.length
                        const next = allSelected ? [] : [...rankingsAvailableSetups]
                        setRankingsSelectedSetups(next)
                        loadRankings(next)
                      }}>
                      {rankingsSelectedSetups?.length === rankingsAvailableSetups.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                    {rankingsAvailableSetups.map(s => {
                      const checked = rankingsSelectedSetups?.includes(s) ?? true
                      return (
                        <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked} onChange={() => {
                            const next = checked
                              ? (rankingsSelectedSetups ?? rankingsAvailableSetups).filter(x => x !== s)
                              : [...(rankingsSelectedSetups ?? rankingsAvailableSetups), s]
                            setRankingsSelectedSetups(next)
                            loadRankings(next)
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
                      onClick={() => { setRankingsSrc(src); if (src === 'human') setRankingsDim('overall') }}>
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
                        onClick={() => !disabled && setRankingsDim(d)}
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
              <select style={styles.pwSelect} value={setupA} onChange={e => setSetupA(e.target.value)}>
                <option value=''>— select —</option>
                {setups.map(s => <option key={s.id} value={s.id}>{s.id} ({s.figures.length})</option>)}
              </select>
            </div>
            <div style={styles.pwStack}>
              <div style={styles.pwLabel}>Setup B</div>
              <select style={styles.pwSelect} value={setupB} onChange={e => setSetupB(e.target.value)}>
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
            {matchingFigures && (
              <div style={styles.pwMatchCount}>{matchingFigures.length} figure{matchingFigures.length !== 1 ? 's' : ''} in common</div>
            )}
            {!READ_ONLY && (
              <button
                style={{ ...styles.pwRunBtn, ...(!matchingFigures || matchingFigures.length === 0 || running ? styles.pwRunBtnDisabled : {}) }}
                disabled={!matchingFigures || matchingFigures.length === 0 || running}
                onClick={runMachineEval}
              >
                {running ? 'Running…' : 'Run Machine Evaluation'}
              </button>
            )}
          </div>
          {READ_ONLY && (
            <div style={{ ...styles.pwEvalNotice, marginTop: 12, marginBottom: 0 }}>
              Read-only deployment — results below are the ones committed to the repo.
              Evaluations call an LLM and write to <code>benchmark_results/</code>, which needs
              the local dev server: clone the repo and run <code>npm run dev</code>.
            </div>
          )}
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
        {setupA && setupB && setupA !== setupB && (
          <div style={styles.pwCard}>
            <div style={{ ...styles.pwCardTitle, cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => setMachineTableOpen(o => !o)}>
              <span>{machineTableOpen ? '▾' : '▸'} Machine Results — {shortSetup(setupA)} vs {shortSetup(setupB)}</span>
              {!READ_ONLY && (
                <button style={styles.pwDangerLinkBtn}
                  onClick={e => { e.stopPropagation(); deleteAllMachineEvals() }}>Delete All</button>
              )}
            </div>
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
                              onClick={() => {
                                const idx = sortedMatchingFigures.findIndex(f => f.name === r.figure && f.subject === r.subject)
                                setCompViewerFigIndex(idx >= 0 ? idx : 0)
                              }}
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
                <tfoot>
                  <tr style={styles.pwSummaryRow}>
                    <td style={{ ...styles.pwTd, fontWeight: 700, color: 'var(--text)', fontSize: 11 }}>Summary</td>
                    {DIMENSIONS.map(d => {
                      const evald = mergedRows.filter(r => r.machineEval?.dimensions?.[d])
                      const aW = evald.filter(r => r.machineEval.dimensions[d].winner === setupA).length
                      const bW = evald.filter(r => r.machineEval.dimensions[d].winner === setupB).length
                      const tW = evald.filter(r => r.machineEval.dimensions[d].winner === 'tie').length
                      return (
                        <td key={d} style={{ ...styles.pwTd, fontSize: 10 }}>
                          {evald.length === 0
                            ? <span style={styles.pwMuted}>—</span>
                            : <><span style={{ color: 'var(--badge-a-text)' }}>A:{aW}</span>{' · '}<span style={{ color: 'var(--badge-b-text)' }}>B:{bW}</span>{tW > 0 && <>{' · '}<span style={{ color: 'var(--badge-tie-text)' }}>T:{tW}</span></>}</>}
                        </td>
                      )
                    })}
                    {(() => {
                      const evald = mergedRows.filter(r => r.machineEval?.aggregator)
                      const aW = evald.filter(r => r.machineEval.aggregator.winner === setupA).length
                      const bW = evald.filter(r => r.machineEval.aggregator.winner === setupB).length
                      const tW = evald.filter(r => r.machineEval.aggregator.winner === 'tie').length
                      const avgConf = evald.length > 0 ? evald.reduce((s, r) => s + r.machineEval.aggregator.confidence, 0) / evald.length : null
                      return (
                        <>
                          <td style={{ ...styles.pwTd, fontSize: 10 }}>
                            {evald.length === 0
                              ? <span style={styles.pwMuted}>—</span>
                              : <><span style={{ color: 'var(--badge-a-text)' }}>A:{aW}</span>{' · '}<span style={{ color: 'var(--badge-b-text)' }}>B:{bW}</span>{tW > 0 && <>{' · '}<span style={{ color: 'var(--badge-tie-text)' }}>T:{tW}</span></>}</>}
                          </td>
                          <td style={{ ...styles.pwTd, fontSize: 11, color: 'var(--text-muted)' }}>
                            {avgConf !== null ? (avgConf * 100).toFixed(0) + '%' : '—'}
                          </td>
                          <td style={styles.pwTd} />
                        </>
                      )
                    })()}
                  </tr>
                </tfoot>
              </table>
            ))}
          </div>
        )}

        {/* Panel 4 — Human Results Table */}
        {setupA && setupB && setupA !== setupB && (
          <div style={styles.pwCard}>
            <div style={{ ...styles.pwCardTitle, cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
              onClick={() => setHumanTableOpen(o => !o)}>
              <span>{humanTableOpen ? '▾' : '▸'} Human Results — {shortSetup(setupA)} vs {shortSetup(setupB)}</span>
            </div>
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
                <tfoot>
                  {(() => {
                    const evald = mergedRows.filter(r => (r.humanEvals || []).length > 0)
                    const aW = evald.filter(r => r.humanEvals[0].winner === setupA).length
                    const bW = evald.filter(r => r.humanEvals[0].winner === setupB).length
                    const tW = evald.filter(r => r.humanEvals[0].winner === 'tie').length
                    return (
                      <tr style={styles.pwSummaryRow}>
                        <td style={{ ...styles.pwTd, fontWeight: 700, color: 'var(--text)', fontSize: 11 }}>Summary</td>
                        <td style={{ ...styles.pwTd, fontSize: 10 }}>
                          {evald.length === 0
                            ? <span style={styles.pwMuted}>—</span>
                            : <><span style={{ color: 'var(--badge-a-text)' }}>A:{aW}</span>{' · '}<span style={{ color: 'var(--badge-b-text)' }}>B:{bW}</span>{tW > 0 && <>{' · '}<span style={{ color: 'var(--badge-tie-text)' }}>T:{tW}</span></>}</>}
                        </td>
                        <td style={styles.pwTd} />
                        <td style={styles.pwTd} />
                      </tr>
                    )
                  })()}
                </tfoot>
              </table>
            ))}
          </div>
        )}
      </div>
    )
  )
}
