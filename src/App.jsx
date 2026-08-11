import { useState, useEffect } from 'react';
import './App.css';
import FigureViewer from './components/FigureViewer.jsx';
import ExperimentViewer from './components/ExperimentViewer.jsx';
import PairwiseTab from './components/pairwise/PairwiseTab.jsx';
import HumanEvalPage from './components/pairwise/HumanEvalPage.jsx';
import OutputPage from './components/OutputPage.jsx';

const TABS = [
  { id: 'figures', label: 'Figures' },
  { id: 'outputs', label: 'Outputs' },
  { id: 'benchmark', label: 'Benchmark' },
];

const TAB_STORAGE_KEY = 'activeTab';

/**
 * Hash routing rather than history routing: the human evaluator and the
 * single-output view each open in their own browser tab, and a hash URL needs no
 * rewrite rule to survive a hard load on a static host.
 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const qIndex = hash.indexOf('?');
  return {
    route: (qIndex >= 0 ? hash.slice(1, qIndex) : hash.slice(1)),
    params: new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : ''),
  };
}

export default function App() {
  const { route, params } = useHashRoute();
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY);
      return TABS.some(t => t.id === saved) ? saved : 'figures';
    } catch { return 'figures'; }
  });

  const selectTab = id => {
    setTab(id);
    try { localStorage.setItem(TAB_STORAGE_KEY, id); } catch { /* private mode */ }
  };

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

  return (
    <div className="app-shell">
      <nav className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => selectTab(t.id)}
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
