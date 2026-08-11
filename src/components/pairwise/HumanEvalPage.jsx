import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { styles } from './styles.js'
import { htmlUrl, imageUrl } from './helpers.js'
import {
  READ_ONLY, fetchMatchingFigures, fetchResults, fetchHtml,
  submitHumanEval, clearHumanEval,
} from '../../api.js'

/** Fisher-Yates, on a copy. */
function shuffled(items) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const rowKey = f => `${f.subject}__${f.name ?? f.figure}`

/**
 * Blind human A/B judging, as a standalone page opened in its own tab.
 *
 * Figures are walked in a random order fixed for the session, and each one's
 * left/right assignment is drawn once when that order is built — so stepping
 * Back and forward again shows the same sides rather than silently reshuffling
 * a figure the judge has already looked at.
 */
export default function HumanEvalPage({ setupA, setupB }) {
  const [figures, setFigures] = useState(null)   // randomized [{fig, leftIsA}]
  const [index, setIndex] = useState(0)
  const [judged, setJudged] = useState({})       // rowKey -> humanEval
  const [winner, setWinner] = useState(null)     // resolved setup id, or 'tie'
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [htmls, setHtmls] = useState({ a: null, b: null })
  const htmlCache = useRef(new Map())

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchMatchingFigures(setupA, setupB), fetchResults(setupA, setupB)])
      .then(([matching, results]) => {
        if (cancelled) return
        setFigures(shuffled(matching).map(fig => ({ fig, leftIsA: Math.random() < 0.5 })))
        const seen = {}
        for (const r of results) {
          const he = (r.humanEvals || [])[0]
          if (he) seen[rowKey(r)] = he
        }
        setJudged(seen)
      })
    return () => { cancelled = true }
  }, [setupA, setupB])

  const current = figures?.[index] ?? null
  const currentKey = current ? rowKey(current.fig) : null
  const currentJudged = currentKey ? judged[currentKey] : null

  // Load both sides whenever the figure changes. Cached per figure so paging
  // back and forth doesn't refetch — the markup can be hundreds of KB.
  useEffect(() => {
    if (!current) return
    const { fig } = current
    const cached = htmlCache.current.get(fig.name)
    if (cached) { setHtmls(cached); return }

    let cancelled = false
    setHtmls({ a: null, b: null })
    Promise.all([fetchHtml(htmlUrl(fig.htmlPathA)), fetchHtml(htmlUrl(fig.htmlPathB))])
      .then(([a, b]) => {
        if (cancelled) return
        const loaded = { a, b }
        htmlCache.current.set(fig.name, loaded)
        setHtmls(loaded)
      })
    return () => { cancelled = true }
  }, [current])

  // Reset the verdict form when moving to a different figure.
  useEffect(() => {
    setWinner(null)
    setNotes('')
  }, [index])

  const go = useCallback(delta => {
    setIndex(i => Math.min(Math.max(i + delta, 0), (figures?.length ?? 1) - 1))
  }, [figures])

  useEffect(() => {
    const onKey = e => {
      const tag = e.target?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT') return
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  const submit = useCallback(async () => {
    if (!current || !winner) return
    setBusy(true)
    try {
      await submitHumanEval({
        setupA, setupB,
        subject: current.fig.subject,
        figure: current.fig.name,
        winner,
        notes,
      })
      setJudged(j => ({ ...j, [currentKey]: { winner, notes, submittedAt: new Date().toISOString() } }))
      go(1)
    } catch (err) {
      alert('Submit failed: ' + err.message)
    } finally {
      setBusy(false)
    }
  }, [current, currentKey, winner, notes, setupA, setupB, go])

  const rejudge = useCallback(async () => {
    if (!current) return
    setBusy(true)
    try {
      await clearHumanEval({ setupA, setupB, subject: current.fig.subject, figure: current.fig.name })
      setJudged(j => { const next = { ...j }; delete next[currentKey]; return next })
      setWinner(null)
      setNotes('')
    } catch (err) {
      alert('Clear failed: ' + err.message)
    } finally {
      setBusy(false)
    }
  }, [current, currentKey, setupA, setupB])

  const doneCount = useMemo(() => Object.keys(judged).length, [judged])

  if (READ_ONLY) {
    return (
      <div style={styles.pwEvalRoot}>
        <div style={styles.pwEvalBody}>
          <div style={styles.pwEvalNotice}>
            Human evaluation writes to <code>benchmark_results/</code>, which this deployed
            build has no server to do. Run the site locally with <code>npm run dev</code> to judge figures.
          </div>
        </div>
      </div>
    )
  }

  if (!setupA || !setupB || setupA === setupB) {
    return <div style={styles.pwEvalRoot}><div style={styles.pwEvalBody}><div style={styles.pwEmptyMsg}>Two different setups are required.</div></div></div>
  }

  if (figures === null) {
    return <div style={styles.pwEvalRoot}><div style={styles.pwEvalBody}><div style={styles.pwEmptyMsg}>Loading figures…</div></div></div>
  }

  if (figures.length === 0) {
    return <div style={styles.pwEvalRoot}><div style={styles.pwEvalBody}><div style={styles.pwEmptyMsg}>These setups have no figures in common.</div></div></div>
  }

  const { fig, leftIsA } = current
  const refPath = fig.imagePathA || fig.imagePathB
  const sides = [
    { side: 'left', label: 'Left', html: leftIsA ? htmls.a : htmls.b, setup: leftIsA ? setupA : setupB },
    { side: 'right', label: 'Right', html: leftIsA ? htmls.b : htmls.a, setup: leftIsA ? setupB : setupA },
  ]

  return (
    <div style={styles.pwEvalRoot}>
      <header style={styles.pwEvalHeader}>
        <div>
          <h1 style={styles.pwEvalTitle}>Human Evaluation</h1>
          <p style={styles.pwEvalSubtitle}>{setupA} vs {setupB} · {doneCount} of {figures.length} judged</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          {currentJudged && <span style={styles.pwEvalJudged}>✓ Judged</span>}
          <button
            style={{ ...styles.pwCompNavBtn, ...(index === 0 ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
            disabled={index === 0}
            onClick={() => go(-1)}
          >← Back</button>
          <span style={styles.pwEvalCounter}>{index + 1} / {figures.length}</span>
          <button
            style={{ ...styles.pwCompNavBtn, ...(index === figures.length - 1 ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
            disabled={index === figures.length - 1}
            onClick={() => go(1)}
          >Next →</button>
        </div>
      </header>

      <div style={styles.pwEvalBody}>
        {refPath && (
          <div style={{ marginBottom: 18, textAlign: 'center' }}>
            <div style={styles.pwSectionLabel}>Reference Figure</div>
            <img src={imageUrl(refPath)} alt="Original reference figure" style={styles.pwRefImage} />
            <div style={{ ...styles.pwSubtle, marginTop: 6 }}>{fig.name} · {fig.subject} · {fig.type}</div>
          </div>
        )}

        <div style={styles.pwIframeRow}>
          {sides.map(({ side, label, html }) => (
            <div key={side} style={styles.pwIframeWrap}>
              <div style={styles.pwIframeLabel}>{label}</div>
              {html === null
                ? <div style={styles.pwEvalPlaceholder}>Rendering…</div>
                : <iframe
                  style={styles.pwEvalIframe}
                  srcDoc={html}
                  title={`${label} figure`}
                  sandbox='allow-scripts allow-same-origin'
                />}
            </div>
          ))}
        </div>

        {currentJudged ? (
          <div style={styles.pwEvalNotice}>
            You have already judged this figure.{currentJudged.notes ? ` Notes: “${currentJudged.notes}”` : ''}
            {' '}
            <button style={styles.pwLinkBtn} disabled={busy} onClick={rejudge}>Clear and re-judge</button>
            {/* The recorded winner is deliberately not shown — it would unblind a
                re-judge, and the sides are randomized per figure anyway. */}
          </div>
        ) : (
          <>
            <div style={styles.pwDimRow}>
              <div style={styles.pwDimName}>Overall winner</div>
              <div style={styles.pwToggleGroup}>
                {sides.map(({ side, label, setup }) => (
                  <button
                    key={side}
                    style={{ ...styles.pwToggleBtn, ...(winner === setup ? styles.pwToggleBtnActive : {}) }}
                    onClick={() => setWinner(setup)}
                  >{label}</button>
                ))}
                <button
                  style={{ ...styles.pwToggleBtn, ...(winner === 'tie' ? styles.pwToggleBtnActive : {}) }}
                  onClick={() => setWinner('tie')}
                >Tie</button>
              </div>
            </div>
            <textarea
              style={styles.pwNotesArea}
              placeholder='Optional notes…'
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
            <button
              style={{ ...styles.pwSubmitBtn, ...(!winner || busy ? styles.pwSubmitBtnDisabled : {}) }}
              disabled={!winner || busy}
              onClick={submit}
            >
              {busy ? 'Submitting…' : 'Submit and continue'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
