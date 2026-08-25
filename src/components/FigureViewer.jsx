import { useState, useEffect, useMemo, useCallback } from 'react';
import { Badge, FilterGroup } from './common.jsx';
import { useUrlState } from '../lib/urlState.js';

const SUBJECTS = ['math', 'cs', 'physics', 'chemistry'];
const TYPES = ['2d', '3d'];
const SETS = ['benchmark', 'candidates'];

// Candidate figures live in a `new_<subject>` folder and share the benchmark's
// subject taxonomy — they just have no prompt or interactions written yet, so
// they are browsable but off by default.
const isCandidate = fig => fig.subject.startsWith('new_');
const baseSubject = fig => fig.subject.replace(/^new_/, '');

function FigureCard({ fig, onClick }) {
  const src = `/images/${fig.subject}/${fig.type}/${fig.stem}${fig.ext || '.png'}`;
  return (
    <div className="card" onClick={() => onClick(fig)} role="button" tabIndex={0}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick(fig)}>
      <div className="card-img-wrap">
        <img src={src} alt={fig.stem} loading="lazy" />
      </div>
      <div className="card-meta">
        <span className="card-stem">{fig.stem}</span>
        <div className="card-badges">
          <Badge kind="subject" value={baseSubject(fig)} />
          <Badge kind="type" value={fig.type} />
          {isCandidate(fig) && <span className="badge badge-candidate">candidate</span>}
        </div>
      </div>
    </div>
  );
}

function InteractionsList({ text }) {
  if (!text) return null;
  const items = text.split('\n').map(l => l.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
  return (
    <ul className="modal-interactions-list">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

function FigureModal({ fig, ctx, onClose }) {
  const src = `/images/${fig.subject}/${fig.type}/${fig.stem}${fig.ext || '.png'}`;

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>

        <div className="modal-body">
          <div className="modal-img-pane">
            <img src={src} alt={fig.stem} className="modal-img" />
          </div>

          <div className="modal-info-pane">
            <div className="modal-fig-header">
              <span className="modal-stem">{fig.stem}</span>
              <div className="card-badges">
                <Badge kind="subject" value={baseSubject(fig)} />
                <Badge kind="type" value={fig.type} />
                {isCandidate(fig) && <span className="badge badge-candidate">candidate</span>}
              </div>
            </div>

            {isCandidate(fig) && !ctx && (
              <div className="modal-candidate-note">
                Candidate figure — no input prompt or interactions generated yet.
              </div>
            )}

            {ctx?.['input prompt'] && (
              <section className="modal-section">
                <h3 className="modal-section-label">Input Prompt</h3>
                <p className="modal-section-text">{ctx['input prompt']}</p>
              </section>
            )}

            {ctx?.interactions && (
              <section className="modal-section">
                <h3 className="modal-section-label">Interactions</h3>
                <InteractionsList text={ctx.interactions} />
              </section>
            )}

            {ctx?.context && (
              <section className="modal-section">
                <h3 className="modal-section-label">Context</h3>
                <p className="modal-section-text modal-context">{ctx.context}</p>
              </section>
            )}

            {ctx?.source && (
              <div className="modal-source">Source: {ctx.source}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FigureViewer() {
  const [figures, setFigures] = useState([]);
  const [contexts, setContexts] = useState({});
  const [loading, setLoading] = useState(true);

  // Both filters and the open figure live in the URL, so a view is linkable:
  // #figures?subject=math&type=3d&figure=11.3
  const { params, setParams } = useUrlState();
  const set = params.get('set') || 'benchmark';
  const subject = params.get('subject') || 'all';
  const type = params.get('type') || 'all';
  const openStem = params.get('figure');

  useEffect(() => {
    Promise.all([
      fetch('/figures.json').then(r => r.json()),
      fetch('/contexts_export.json').then(r => r.json()).catch(() => []),
    ]).then(([figs, ctxs]) => {
      setFigures(figs);
      const map = {};
      ctxs.forEach(c => { if (c.figure_id) map[String(c.figure_id)] = c; });
      setContexts(map);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => figures.filter(f =>
    (set === 'all' || isCandidate(f) === (set === 'candidates')) &&
    (subject === 'all' || baseSubject(f) === subject) &&
    (type === 'all' || f.type === type)
  ), [figures, set, subject, type]);

  // Stems are globally unique in figures.json, so one is enough to name a figure
  // whatever the filters are set to.
  const selected = useMemo(
    () => (openStem ? figures.find(f => f.stem === openStem) ?? null : null),
    [figures, openStem],
  );

  const setSet = useCallback(v => setParams({ set: v === 'benchmark' ? null : v }, { replace: true }), [setParams]);
  const setSubject = useCallback(v => setParams({ subject: v === 'all' ? null : v }, { replace: true }), [setParams]);
  const setType = useCallback(v => setParams({ type: v === 'all' ? null : v }, { replace: true }), [setParams]);

  // Opening pushes an entry so Back closes the modal; closing spends that entry
  // rather than leaving one behind that Back would use to re-open it.
  const handleCardClick = useCallback(fig => setParams({ figure: fig.stem }), [setParams]);
  const handleClose = useCallback(() => setParams({ figure: null }, { replace: true }), [setParams]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">Benchmark Figures</div>
        </div>

        <nav className="filters">
          <FilterGroup label="Set" options={SETS} value={set} onChange={setSet} />
          <FilterGroup label="Subject" options={SUBJECTS} value={subject} onChange={setSubject} />
          <FilterGroup label="Type" options={TYPES} value={type} onChange={setType} />
        </nav>

        <div className="sidebar-count">
          {loading ? '—' : `${filtered.length} of ${figures.length} figures`}
        </div>
      </aside>

      <main className="main">
        {loading ? (
          <div className="state-msg">Loading figures…</div>
        ) : filtered.length === 0 ? (
          <div className="state-msg">No figures match these filters.</div>
        ) : (
          <div className="grid">
            {filtered.map(fig => (
              <FigureCard
                key={`${fig.subject}-${fig.type}-${fig.stem}`}
                fig={fig}
                onClick={handleCardClick}
              />
            ))}
          </div>
        )}
      </main>

      {selected && (
        <FigureModal
          fig={selected}
          ctx={contexts[String(selected.stem)]}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
