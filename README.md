# Benchmark Figures

A static benchmark dataset of hand-labeled scientific figures, categorized by subject and dimensionality (2d vs. 3d). Comes with a small browser-based viewer for browsing and filtering the set.

## Dataset

Figures live in `public/images/{subject}/{type}/{stem}{ext}` and are indexed by `public/figures.json`, which is generated from that tree rather than hand-edited (`server/figures_manifest.js`). Each manifest entry has the shape:

```json
{ "stem": "CNX_Chem_01_01_FuelCell", "subject": "chemistry", "type": "2d", "ext": ".jpg" }
```

- **`subject`**: `physics` | `chemistry` | `cs` | `math`, plus `new_physics` | `new_chemistry` | `new_math` for the candidates below
- **`type`**: `2d` (flat diagrams, schematics, graphs) | `3d` (spatial/volumetric illustrations)

Current counts:

| Subject          | 2d | 3d | Total |
|------------------|----|----|-------|
| Physics          | 10 | 15 |    25 |
| Chemistry        | 12 | 13 |    25 |
| Computer Science | 13 | 12 |    25 |
| Math             | 12 | 13 |    25 |
| **Total**        | **47** | **53** | **100** |

### Candidate figures

Three staging folders hold additional figures sourced from OpenStax. They are
indexed in `figures.json` like everything else, under the `new_*` subjects, and
kept out of the benchmark by that naming: the Figures tab's benchmark/candidates
switch shows the settled 100 by default, and the evaluator only sees figures that
have generated output in `experiments/`, which no candidate has.

| Folder | Source | 2d | 3d | Total |
|--------|--------|----|----|-------|
| `new_physics/`   | OpenStax *University Physics* (Volumes 1–3) | 16 | 24 |  40 |
| `new_chemistry/` | OpenStax *Organic Chemistry* + *Chemistry 2e* | 16 | 18 |  34 |
| `new_math/`      | OpenStax *Algebra and Trigonometry 2e* + *Calculus Volume 3* | 25 | 18 |  43 |
| **Total**        |                              | **57** | **60** | **117** |

Those are the counts on disk now, after a curation pass. The initial pull was
larger — 43, 66, and 61 figures — and each folder used to carry a `manifest.json`
recording it, with the source chapter, section, caption, and the textbook's alt
text. Those manifests have been removed; the files on disk are the record.

A candidate has no row in `contexts_export.json`, so it has no figure brief and
cannot be evaluated until one is authored in `contexts.xlsx`.

`new_math` draws on two books because one could not supply both halves.
*Algebra and Trigonometry 2e* is almost entirely planar — its entire 3D
inventory is the conic-section cone slices, the plane arrangements for systems
in three variables, and three labeled solids — so it caps out at 11 spatial
figures, six of which survive the curation pass. The other 12 come from
*Calculus Volume 3*, whose multivariable chapters are the opposite: quadric
surfaces, tangent planes and gradients, space curves, vector fields, and solids
of integration. Every 2d figure is from *Algebra and Trigonometry 2e*; each
entry's `book` field records its source.

`new_chemistry` draws on two books for a different reason. *Organic Chemistry*
is a book of drawn molecules, so once the conformer, orbital, chirality and
spectrum templates were curated away, what was left to refill with was more
drawn molecules — dense ones. *Chemistry 2e* has the visual vocabulary that book
lacks: packing diagrams, glassware, band and energy-level diagrams, phase and
free-energy plots. The ten Chemistry 2e figures were picked for how few things
each one is made of, and checked against the settled 25 — which come from the
same book — so none repeats a unit cell, a VSEPR wireframe or a hybrid orbital
already in the benchmark. Here too the `book` field records the source.

`new_physics` is one book, but its 3d half has since been topped up: ten more
spatial figures from *University Physics*, seven of which survive, taking it
from 17 to 24. The settled physics 25 are the odd ones out here — they are
*Foundations of Computer Vision*, camera and projection geometry rather than
mechanics — so the check that mattered was against the 17 candidates already
in the folder, which had used up the vector-in-axes, Gaussian-box and
polarizing-filter templates. The ten came from nine different chapters — only
33 repeated — and no two were the same kind of picture.

Promoting a figure into the benchmark means moving its file into
`public/images/{subject}/{type}/`; `figures.json` is regenerated from the tree,
so only the counts tables above need updating by hand.

## App

A React + Vite app with four tabs.

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

### Figures tab

Browses the dataset. Figures can be filtered by subject and type; clicking one opens
its prompt, intended interactions, and textbook context.

### Outputs tab

Browses one experiment's outputs. Filter by subject and 2d/3d, sort by name,
subject, or type, and switch experiments from the sidebar.

The grid shows each figure as a still image, so switching experiments actually
changes what you see. Those stills are pre-rendered captures (see below);
figures the capture sweep hasn't reached fall back to the original benchmark
image, and the sidebar reports how many of the setup's figures are captured.
Clicking a card opens the original beside that experiment's generated figure,
which is live and interactive there.

Keeping the generated pages out of the grid is deliberate: they are real pages
running Three.js or SVG.js, and rendering a hundred of them at thumbnail size was
both slow and unreadable, since each reflows its controls over the artwork at
that width. A still has neither problem.

### Figure screenshots

```bash
npm run screenshots                              # everything not yet captured
npm run screenshots -- --setup baseline-gpt_FINAL
npm run screenshots -- --stem 14.2.10 --force
```

Renders every `experiments/<setup>/<stem>.html` headlessly and writes
`screenshots/<setup>/<stem>.jpg`. Two things read that directory: the Outputs
grid, and the evaluator's faithfulness and labels dimensions.

Renders are serialized — one page at a time keeps memory bounded and stops
concurrent 3D figures from contending over SwiftShader — so budget roughly five
seconds per figure. The run is resumable: it skips whatever is already on disk
unless `--force` is passed, captures are written via a temp file and a rename so
an interrupt can't leave a half-written JPEG behind, and Ctrl-C closes the
browser and stops after the figure in flight. `--list` prints the queue without
rendering anything.

The directory is gitignored and entirely regenerable. Nothing depends on it
existing: a missing capture makes the evaluator render that one figure on demand
(writing it back to the same cache, so an eval run warms the grid), and makes the
Outputs card fall back to the reference image.

### Benchmark tab

Runs and reviews head-to-head comparisons of generated figures, ported from the
pairwise evaluator in `visionbook/figure-platform`.

Put each experiment's output in its own subfolder of `experiments/`, one HTML file
per figure named by its stem — see [`experiments/README.md`](experiments/README.md).
Pick two setups and hit **Run Machine Evaluation**: five dimension agents (geometry,
interactivity, faithfulness, labels, concept) compare the pair in parallel, then an
aggregator returns an overall winner.

Three of those dimensions are aimed at correctness rather than resemblance, because
every setup generates the same figures from the same brief. **Interactivity** judges
whether the interactions are implemented right — handlers computing the quantity they
claim, sensible control ranges, and behaviour that holds at the boundaries — not how
many there are. **Concept** judges whether the figure is factually true, treating the
original as context rather than ground truth, so an error counts even when the original
shares it. **Faithfulness** asks that a
reader recognise the same figure, not that it be a pixel-level replacement, so added
controls or a rearranged layout of the same content are not penalised. Which figure is shown as "Figure 1" is
randomized per figure and held fixed across all six calls, so position bias can't
accumulate. Only the geometry prompt differs between 2d and 3d — one rewards depth
and viewpoint, the other forbids judging them — selected from the figure's `type` in
`figures.json`. The other four dimensions share a single prompt with the medium's
preamble swapped in, so they cannot drift apart.

Results are written to `benchmark_results/<judge>/<setupA>_vs_<setupB>.json` — one
file per pair, keyed by `<subject>__<stem>` — and re-runs skip figures that already
have a machine evaluation. The tab also has a side-by-side comparison viewer and
Bradley-Terry rankings across every pair file, overall and per dimension.

Each judge keeps a result set of its own — `benchmark_results/gemini/` and
`benchmark_results/gpt5.5/` — because verdicts from two judges disagree, and a
ranking over a mixture of them ranks nothing in particular. Pick the judge in the
Benchmark tab or with `--model`; it decides both which results you are looking at
and where a new run writes, and each is planned and resumed on its own progress.
Human verdicts sit apart from all of them in `benchmark_results/human/`, since a
human judgement is the ground truth every judge is measured against rather than one
more opinion to file beside them — so it is recorded once and shown under every
judge. The rankings table can also be restricted to one layer of the design:
**Ablation** for the within-model pipeline pairs, **Rotation** for the cross-model
round robin, which is the only place two models ever meet. See `server/judges.js`.

### Human evaluation

**Open Human Evaluation ↗** in the Human Results panel opens a judging pass for
that pair in a new browser tab (`#human-eval?setupA=…&setupB=…`). It shows the
reference figure above the two generated ones and steps through every figure with
Back / Next or the arrow keys.

The pass is blind twice over: figures come in a random order, and each one's
left/right assignment is drawn independently. Both are fixed when the pass opens,
so stepping Back and forward again returns to the same figure with the same sides
rather than reshuffling something already judged. Revisiting a judged figure shows
that it is judged and its notes, but not which side won — that would unblind a
re-judge. Submitting advances to the next figure. The Benchmark tab reloads its
results whenever it regains focus, so verdicts appear there without a refresh.

Human evaluations are stored alongside the machine ones in the same pair file and
are never overwritten by a machine re-run.

## Deploying (read-only)

The `/api` routes are registered by a Vite `configureServer` hook, which only runs
under `npm run dev`. A production build therefore has no API at all: nothing
deployed can spend an LLM call or write to `benchmark_results/`. That is the
mechanism, not a UI setting — the run, delete, and human-evaluation controls are
hidden in a deployed build because there is nothing behind them, and the Benchmark
tab says so.

So that browsing still works without a server, `vite build` also exports the data
the read paths need into `dist/`:

| Path | Contents |
|---|---|
| `dist/experiments/<setup>/*.html` | copies of the generated figures |
| `dist/screenshots/<setup>/*.jpg` | pre-rendered stills for the Outputs grid |
| `dist/api-static/setups.json` | the setup index, with dist-relative paths |
| `dist/api-static/results/*.json` | one file per evaluated pair |
| `dist/api-static/ranking-records.json` | winners only, ranked in the browser |

`src/api.js` picks between the two sources on `import.meta.env.DEV`, so the
deployed Figures, Outputs, and Benchmark tabs all read the committed results.
Bradley-Terry scoring is shared between the server and the browser
(`src/lib/rankings.js`), so a deployed ranking matches what `npm run dev` computes.

Preview the deployed build locally with `npm run build && npm run preview` — that
is a faithful read-only run, API and all.

**One catch:** `.gitignore` excludes `/experiments` and `/screenshots`, so a Vercel
build from GitHub finds no experiment HTML and the Outputs and Benchmark tabs come
up empty (the build logs a warning when this happens). Either un-ignore those
directories and commit them — about 70 MB of HTML plus the captures — or deploy
with `vercel --prod` from a working copy, which uploads the working tree and
honours `.vercelignore` instead of `.gitignore`.

## Credits

### Math figures

Figures are from:

> Anton, Bivens, and Davis. *Calculus, 10th Edition*
> © John Wiley & Sons

> OpenStax *Calculus Volume 3*
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/calculus-volume-3

> OpenStax *Algebra and Trigonometry 2e*
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/algebra-and-trigonometry-2e

### Chemistry figures

Figures are from:

> OpenStax *Chemistry 2e*
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/chemistry-2e

> OpenStax *Organic Chemistry*
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/organic-chemistry

### Computer Science figures

Figures are from:

> Prince, Simon J.D. *Understanding Deep Learning*
> Licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)
> https://udlbook.github.io/udlbook/

> Cormen, Leiserson, Rivest, and Stein. *Introduction to Algorithms, Third Edition*
> © The MIT Press

### Physics figures

Figures are from:

> Torralba, Isola, and Freeman. *Foundations of Computer Vision*
> © Antonio Torralba, Phillip Isola, and William Freeman
> Published by The MIT Press, 2024
> Licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)
> https://visionbook.mit.edu/

> OpenStax *University Physics* (Volumes 1–3)
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/university-physics-volume-1
