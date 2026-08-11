# Experiments

One subfolder per experiment. Each subfolder is a **setup** in the Benchmark tab's
pairwise evaluator, and holds one generated HTML file per figure:

```
experiments/
  baseline-gpt_FINAL/
    CNX_Chem_09_01_Manometer__msl1h3eya84qb.html
    14_2_10__msl2l3ouu52yo.html
    ...
  full-pipeline-gpt_FINAL/
    CNX_Chem_09_01_Manometer__msdkjghbzcqnb.html
    ...
```

Each file is matched back to a figure in `public/figures.json` by
`resolveStem()` in `server/setups.js`, which tries, in order:

1. the filename as-is (`CNX_Chem_09_01_Manometer`)
2. with a trailing `__<runid>` stripped (`…__msl1h3eya84qb` → `CNX_Chem_09_01_Manometer`)
3. either of those with `_` replaced by `.` (`14_2_10` → `14.2.10`)

Every candidate is checked against `figures.json` rather than rewritten blindly,
so stems that legitimately contain underscores are matched at step 1 and the dot
fallback never touches them. Files that match nothing are skipped with a warning
— there's no reference image or context row to judge them against.

Two setups are comparable on every stem they both contain; the evaluator joins on
stem alone, so folders don't need identical file names or the same figures.

Each figure's subject, 2d/3d type, and reference image come from
`public/figures.json`; the grounding text the concept agent reads comes from that
stem's row in `public/contexts_export.json`.

`<stem>.thumb.b64` files appear alongside the HTML — cached headless screenshots
used by the faithfulness and labels dimensions. They're gitignored and regenerate
on demand; delete one to force a re-render.
