import { useState, useEffect, useMemo } from 'react';
import './App.css';

const SUBJECTS = ['math', 'cs', 'physics', 'chemistry'];
const TYPES = ['2d', '3d'];

function Badge({ kind, value }) {
  return <span className={`badge badge-${kind}-${value}`}>{value}</span>;
}

function FigureCard({ fig }) {
  const src = `/images/${fig.subject}/${fig.type}/${fig.stem}${fig.ext || '.png'}`;
  return (
    <div className="card">
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
  const [subject, setSubject] = useState('all');
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/figures.json')
      .then(r => r.json())
      .then(data => { setFigures(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => figures.filter(f =>
    (subject === 'all' || f.subject === subject) &&
    (type === 'all' || f.type === type)
  ), [figures, subject, type]);

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
              <FigureCard key={`${fig.subject}-${fig.type}-${fig.stem}`} fig={fig} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
