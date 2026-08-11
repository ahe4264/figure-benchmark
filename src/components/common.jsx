// Small presentational pieces shared by the Figures and Outputs tabs.

export function Badge({ kind, value }) {
  return <span className={`badge badge-${kind}-${value}`}>{value}</span>;
}

export function FilterGroup({ label, options, value, onChange }) {
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
