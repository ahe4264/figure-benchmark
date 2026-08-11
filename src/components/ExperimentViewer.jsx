import { useState, useEffect, useMemo, useCallback } from 'react';
import { Badge, FilterGroup } from './common.jsx';
import { imageUrl, outputUrl, screenshotUrl } from '../urls.js';
import { fetchSetups } from '../api.js';

const SUBJECTS = ['math', 'cs', 'physics', 'chemistry'];
const TYPES = ['2d', '3d'];

const SORTS = [
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'name-desc', label: 'Name (Z–A)' },
  { id: 'subject', label: 'Subject, then name' },
  { id: 'type', label: 'Type, then name' },
];

function byName(a, b) { return a.stem.localeCompare(b.stem, undefined, { numeric: true }); }

const COMPARATORS = {
  'name': byName,
  'name-desc': (a, b) => byName(b, a),
  'subject': (a, b) => a.subject.localeCompare(b.subject) || byName(a, b),
  'type': (a, b) => a.type.localeCompare(b.type) || byName(a, b),
};

/**
 * Cards show this experiment's own rendered output, so switching experiments
 * actually changes what you see. That is a pre-rendered capture from
 * `npm run screenshots` — never a live iframe, which is what made the grid
 * unreadable. Figures the sweep hasn't reached yet fall back to the reference
 * image so the grid still fills in.
 */
function OutputCard({ fig, onOpen }) {
  const captured = fig.hasScreenshot && fig.screenshotPath;
  const preview = captured ? screenshotUrl(fig.screenshotPath) : imageUrl(fig.imagePath);

  return (
    <div className="card" onClick={() => onOpen(fig)} role="button" tabIndex={0}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onOpen(fig)}>
      <div className="card-img-wrap"
        title={captured ? `${fig.stem} — generated output` : `${fig.stem} — reference image (not captured yet)`}>
        {preview
          ? <img src={preview} alt={captured ? `${fig.stem} generated output` : `${fig.stem} reference`} loading="lazy" />
          : <div className="out-missing">no preview</div>}
      </div>
      <div className="card-meta">
        <span className="card-stem" title={fig.stem}>{fig.stem}</span>
        <div className="card-badges">
          <Badge kind="subject" value={fig.subject} />
          <Badge kind="type" value={fig.type} />
        </div>
      </div>
    </div>
  );
}

/**
 * Browses one experiment's figures, filterable by subject and 2d/3d. Cards show
 * the original benchmark image; clicking one opens it beside the generated page
 * in a new browser tab.
 */
export default function ExperimentViewer() {
  const [setups, setSetups] = useState([]);
  const [setup, setSetup] = useState('');
  const [subject, setSubject] = useState('all');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('name');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSetups().then(list => {
      setSetups(list);
      // Default to the first setup that actually has figures.
      setSetup(prev => prev || (list.find(s => s.figures.length > 0)?.id ?? ''));
      setLoading(false);
    });
  }, []);

  const figures = useMemo(() => {
    const s = setups.find(x => x.id === setup);
    if (!s) return [];
    return s.figures.map(f => ({ ...f, setup: s.id }));
  }, [setups, setup]);

  const filtered = useMemo(() => {
    const rows = figures.filter(f =>
      (subject === 'all' || f.subject === subject) &&
      (type === 'all' || f.type === type)
    );
    return rows.sort(COMPARATORS[sort] ?? byName);
  }, [figures, subject, type, sort]);

  // How much of this setup the screenshot sweep has covered.
  const captured = useMemo(() => figures.filter(f => f.hasScreenshot).length, [figures]);

  const handleOpen = useCallback(fig => {
    window.open(outputUrl(fig), '_blank', 'noopener');
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">Experiment Outputs</div>
        </div>

        <nav className="filters">
          <div className="filter-group">
            <span className="filter-label">Experiment</span>
            <select className="sidebar-select" value={setup} onChange={e => setSetup(e.target.value)}>
              {setups.map(s => (
                <option key={s.id} value={s.id} disabled={s.figures.length === 0}>
                  {s.id} ({s.figures.length})
                </option>
              ))}
            </select>
          </div>

          <FilterGroup label="Subject" options={SUBJECTS} value={subject} onChange={setSubject} />
          <FilterGroup label="Type" options={TYPES} value={type} onChange={setType} />

          <div className="filter-group">
            <span className="filter-label">Sort</span>
            <select className="sidebar-select" value={sort} onChange={e => setSort(e.target.value)}>
              {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
        </nav>

        <div className="sidebar-count">
          {loading ? '—' : `${filtered.length} of ${figures.length} figures · ${captured} captured`}
        </div>
      </aside>

      <main className="main">
        {loading ? (
          <div className="state-msg">Loading experiments…</div>
        ) : setups.length === 0 ? (
          <div className="state-msg">No experiments found. Add a folder under <code>experiments/</code>.</div>
        ) : filtered.length === 0 ? (
          <div className="state-msg">No figures match these filters.</div>
        ) : (
          <div className="grid">
            {filtered.map(fig => (
              <OutputCard key={`${fig.setup}-${fig.stem}`} fig={fig} onOpen={handleOpen} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
