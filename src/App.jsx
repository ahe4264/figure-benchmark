import { useState, useEffect, useMemo, useCallback } from 'react';
import './App.css';

const SUBJECTS = ['math', 'cs', 'physics', 'chemistry'];
const TYPES = ['2d', '3d'];

function Badge({ kind, value }) {
  return <span className={`badge badge-${kind}-${value}`}>{value}</span>;
}

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
          <Badge kind="subject" value={fig.subject} />
          <Badge kind="type" value={fig.type} />
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
                <Badge kind="subject" value={fig.subject} />
                <Badge kind="type" value={fig.type} />
              </div>
            </div>

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

function FilterGroup({ label, options, value, onChange }) {
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      <div className="filter-options">
        <button
          className={`filter-btn${value === 'all' ? ' active' : ''}`}
          onClick={() => onChange('all')}
        >All</button>
        {options.map(opt => (
          <button
            key={opt}
            className={`filter-btn${value === opt ? ' active' : ''}`}
            onClick={() => onChange(opt)}
          >{opt}</button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [figures, setFigures] = useState([]);
  const [contexts, setContexts] = useState({});
  const [subject, setSubject] = useState('all');
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/figures.json').then(r => r.json()),
      fetch('/contexts_export.json').then(r => r.json()).catch(() => []),
    ]).then(([figs, ctxs]) => {
      setFigures(figs);
      const map = {};
      ctxs.forEach(c => { if (c.figure_id) map[c.figure_id] = c; });
      setContexts(map);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => figures.filter(f =>
    (subject === 'all' || f.subject === subject) &&
    (type === 'all' || f.type === type)
  ), [figures, subject, type]);

  const handleCardClick = useCallback(fig => setSelected(fig), []);
  const handleClose = useCallback(() => setSelected(null), []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">Benchmark Figures</div>
        </div>

        <nav className="filters">
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
          ctx={contexts[selected.stem]}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
