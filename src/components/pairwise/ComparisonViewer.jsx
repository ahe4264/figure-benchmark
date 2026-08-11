import { styles } from './styles.js'
import { DIMENSIONS, DIM_LABELS, winnerBadgeStyle, shortSetup, sideLabel, imageUrl } from './helpers.js'

/**
 * Side-by-side view of one figure across two setups, with the machine and human
 * evaluations underneath. Ported from visionbook's ComparisonViewer.
 */
export default function ComparisonViewer({ figure, result, setupA, setupB, htmlA, htmlB, loading, figureIndex, totalFigures, onBack, onPrev, onNext }) {
  const me = result?.machineEval
  const humanEvals = result?.humanEvals || []
  const figNumA = me?.figure1Setup ? (me.figure1Setup === setupA ? '1' : '2') : null
  const figNumB = me?.figure1Setup ? (me.figure1Setup === setupB ? '1' : '2') : null
  const dimRows = DIMENSIONS.map(d => ({
    key: d,
    label: DIM_LABELS[d],
    data: me?.dimensions?.[d] ?? null,
  }))
  const overallRow = {
    key: 'overall', label: 'Overall',
    data: me?.aggregator ? { winner: me.aggregator.winner, confidence: me.aggregator.confidence, rationale: me.aggregator.explanation } : null,
  }
  const allRows = [...dimRows, overallRow]

  return (
    <div style={styles.pwCompRoot}>
      <div style={styles.pwCompHeader}>
        <button style={styles.pwCompBack} onClick={onBack}>← Back</button>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={styles.pwCompFigName}>{figure?.name}</div>
          <div style={styles.pwCompFigSubject}>{figure?.subject}{figure?.type ? ` · ${figure.type}` : ''}</div>
        </div>
        <div style={styles.pwCompNavGroup}>
          <button
            style={{ ...styles.pwCompNavBtn, ...(figureIndex <= 0 ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
            disabled={figureIndex <= 0}
            onClick={onPrev}
          >← Prev</button>
          <span style={styles.pwCompNavCounter}>{figureIndex + 1} / {totalFigures}</span>
          <button
            style={{ ...styles.pwCompNavBtn, ...(figureIndex >= totalFigures - 1 ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
            disabled={figureIndex >= totalFigures - 1}
            onClick={onNext}
          >Next →</button>
        </div>
      </div>

      {(figure?.imagePathA || figure?.imagePathB) && (
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={styles.pwSectionLabel}>Reference Figure</div>
          <img
            src={imageUrl(figure.imagePathA || figure.imagePathB)}
            alt="Original reference figure"
            style={styles.pwRefImage}
          />
        </div>
      )}

      <div style={styles.pwCompIframeRow}>
        {[
          { setup: setupA, html: htmlA, side: 'A', figNum: figNumA, badgeStyle: { ...styles.pwWinnerBadge, ...styles.pwBadgeA } },
          { setup: setupB, html: htmlB, side: 'B', figNum: figNumB, badgeStyle: { ...styles.pwWinnerBadge, ...styles.pwBadgeB } },
        ].map(({ setup, html, side, figNum, badgeStyle }) => (
          <div key={setup} style={styles.pwCompIframeCol}>
            <div style={styles.pwCompIframeLabel}>
              <span style={badgeStyle}>{side}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={setup}>
                {shortSetup(setup)}
              </span>
              {figNum && <span style={styles.pwCompFigNum}>Fig {figNum}</span>}
            </div>
            {loading
              ? <div style={styles.pwCompIframePlaceholder}>Loading…</div>
              : <iframe
                style={styles.pwCompIframe}
                srcDoc={html || ''}
                title={`Setup ${side} — ${setup}`}
                sandbox="allow-scripts allow-same-origin"
              />
            }
          </div>
        ))}
      </div>

      {me ? (
        <div style={styles.pwCard}>
          <div style={styles.pwCardTitle}>
            Pairwise Evaluation Results
            {me.evalModel && <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 8, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>evaluated by {me.evalModel}</span>}
          </div>
          <table style={{ ...styles.pwTable, tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ ...styles.pwTh, width: '16%' }}>Dimension</th>
                <th style={{ ...styles.pwTh, width: '10%' }}>Winner</th>
                <th style={{ ...styles.pwTh, width: '10%' }}>Confidence</th>
                <th style={styles.pwTh}>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {allRows.map(({ key, label, data }) => {
                const rationale = data?.rationale || ''
                return (
                  <tr key={key} style={key === 'overall' ? styles.pwSummaryRow : {}}>
                    <td style={{ ...styles.pwTd, fontWeight: key === 'overall' ? 700 : 600 }}>{label}</td>
                    <td style={styles.pwTd}>
                      {data
                        ? <span style={winnerBadgeStyle(data.winner, setupA, setupB)}>{sideLabel(data.winner, setupA, setupB)}</span>
                        : <span style={styles.pwMuted}>—</span>}
                    </td>
                    <td style={{ ...styles.pwTd, color: 'var(--text-muted)' }}>
                      {data ? `${(data.confidence * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ ...styles.pwTd, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      {rationale || <span style={styles.pwMuted}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={styles.pwCard}>
          <div style={styles.pwCompNoEval}>
            No machine evaluation for this figure yet.{!loading && ' Select it in the setup panel and run Machine Evaluation.'}
          </div>
        </div>
      )}

      {humanEvals.length > 0 && (
        <div style={styles.pwCard}>
          <div style={styles.pwCardTitle}>Human Evaluations</div>
          <table style={{ ...styles.pwTable, tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ ...styles.pwTh, width: '20%' }}>Submitted</th>
                <th style={{ ...styles.pwTh, width: '10%' }}>Winner</th>
                <th style={styles.pwTh}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {humanEvals.map((he, i) => (
                <tr key={i}>
                  <td style={{ ...styles.pwTd, color: 'var(--text-muted)', fontSize: 11 }}>
                    {he.submittedAt ? new Date(he.submittedAt).toLocaleString() : '—'}
                  </td>
                  <td style={styles.pwTd}>
                    <span style={winnerBadgeStyle(he.winner, setupA, setupB)}>{sideLabel(he.winner, setupA, setupB)}</span>
                  </td>
                  <td style={{ ...styles.pwTd, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {he.notes || <span style={styles.pwMuted}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
