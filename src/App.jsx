import { useEffect } from 'react';
import './App.css';
import FigureViewer from './components/FigureViewer.jsx';
import ExperimentViewer from './components/ExperimentViewer.jsx';
import PairwiseTab from './components/pairwise/PairwiseTab.jsx';
import HumanEvalPage from './components/pairwise/HumanEvalPage.jsx';
import OutputPage from './components/OutputPage.jsx';
import { useHashRoute, navigate } from './lib/urlState.js';

const TABS = [
  { id: 'figures', label: 'Figures' },
  { id: 'outputs', label: 'Outputs' },
  { id: 'benchmark', label: 'Benchmark' },
];

const TAB_STORAGE_KEY = 'activeTab';

const EMPTY_PARAMS = new URLSearchParams();

// Each tab's query string, remembered for the session so stepping over to
// another tab and back does not quietly reset the filters. The URL is still the
// only source of truth — this is just what a tab click restores into it.
const lastParams = new Map();

/**
 * The hash names the view: a tab id for the three main tabs, or `human-eval` /
 * `output` for the two pages that open in their own browser tab. Each tab owns
 * its own query parameters — see src/lib/urlState.js.
 */
export default function App() {
  const { route, params } = useHashRoute();
  const isTab = TABS.some(t => t.id === route);

  // A bare URL names no view, so fall back to the tab this browser was last on
  // and write it back. Every other way in — a shared link, Back, a tab click —
  // already carries the view in the hash.
  useEffect(() => {
    if (route) return;
    let last = TABS[0].id;
    try {
      const stored = localStorage.getItem(TAB_STORAGE_KEY);
      if (TABS.some(t => t.id === stored)) last = stored;
    } catch { /* private mode */ }
    navigate(last, EMPTY_PARAMS, { replace: true });
  }, [route]);

  useEffect(() => {
    if (!isTab) return;
    lastParams.set(route, params.toString());
    try { localStorage.setItem(TAB_STORAGE_KEY, route); } catch { /* private mode */ }
  }, [isTab, route, params]);

  if (route === 'human-eval') {
    return (
      <HumanEvalPage
        setupA={params.get('setupA') || ''}
        setupB={params.get('setupB') || ''}
      />
    );
  }

  if (route === 'output') {
    return (
      <OutputPage
        setup={params.get('setup') || ''}
        stem={params.get('stem') || ''}
        subject={params.get('subject') || ''}
        type={params.get('type') || ''}
      />
    );
  }

  // An unknown route renders the first tab while the effect above rewrites it.
  const tab = isTab ? route : TABS[0].id;

  return (
    <div className="app-shell">
      <nav className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => navigate(t.id, new URLSearchParams(lastParams.get(t.id) ?? ''))}
          >{t.label}</button>
        ))}
      </nav>

      {tab === 'figures' && <FigureViewer />}
      {tab === 'outputs' && <ExperimentViewer />}
      {tab === 'benchmark' && (
        <div className="tab-panel-benchmark">
          <PairwiseTab />
        </div>
      )}
    </div>
  );
}
