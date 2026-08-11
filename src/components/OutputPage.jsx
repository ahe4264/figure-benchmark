import { useState, useEffect } from 'react';
import { Badge } from './common.jsx';
import { htmlUrl, imageUrl } from '../urls.js';
import { fetchSetups } from '../api.js';

/**
 * Full-size view of one generated figure beside its reference image, as a
 * standalone page in its own browser tab. The figure is named by the URL rather
 * than handed over in memory, so the tab survives a reload and can be shared.
 */
export default function OutputPage({ setup, stem, subject, type }) {
  const [fig, setFig] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = stem ? `${stem} — ${setup}` : 'Output';
  }, [stem, setup]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSetups().then(list => {
      if (cancelled) return;
      const s = list.find(x => x.id === setup);
      const match = (s?.figures ?? []).find(f =>
        f.stem === stem &&
        (!subject || f.subject === subject) &&
        (!type || f.type === type)
      );
      setFig(match ? { ...match, setup } : null);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [setup, stem, subject, type]);

  if (loading) return <div className="state-msg">Loading figure…</div>;
  if (!fig) {
    return (
      <div className="state-msg">
        No figure <code>{stem}</code> in experiment <code>{setup}</code>.
      </div>
    );
  }

  return (
    <div className="out-page">
      <div className="out-modal-head">
        <span className="out-modal-stem">{fig.stem}</span>
        <div className="card-badges">
          <Badge kind="subject" value={fig.subject} />
          <Badge kind="type" value={fig.type} />
        </div>
        <span className="out-modal-setup">{fig.setup}</span>
      </div>

      <div className="out-modal-body">
        <figure className="out-modal-pane">
          <figcaption className="out-pane-label">Original</figcaption>
          <div className="out-modal-pane-body">
            {fig.imagePath
              ? <img src={imageUrl(fig.imagePath)} alt={`${fig.stem} reference`} />
              : <div className="out-missing">no reference image</div>}
          </div>
        </figure>
        <figure className="out-modal-pane">
          <figcaption className="out-pane-label">Generated</figcaption>
          <div className="out-modal-pane-body">
            <iframe
              src={htmlUrl(fig.htmlPath)}
              title={`${fig.stem} — ${fig.setup}`}
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        </figure>
      </div>
    </div>
  );
}
