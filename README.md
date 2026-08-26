# Benchmark Figures

A static benchmark dataset of hand-labeled scientific figures, categorized by subject and dimensionality (2d vs. 3d). Comes with a small browser-based viewer for browsing and filtering the set.

## Dataset

Figures live in `public/images/{subject}/{type}/{stem}{ext}` and are indexed by `public/figures.json`, which is generated from that tree rather than hand-edited (`server/figures_manifest.js`). Each manifest entry has the shape:

```json
{ "stem": "CNX_Chem_01_01_FuelCell", "subject": "chemistry", "type": "2d", "ext": ".jpg" }
```

- **`subject`**: `physics` | `chemistry` | `cs` | `math`, plus `new_physics` | `new_chemistry` | `new_cs` | `new_math` for the candidates below
- **`type`**: `2d` (flat diagrams, schematics, graphs) | `3d` (spatial/volumetric illustrations)

Current counts:

| Subject              | 2d | 3d | Total |
|----------------------|----|----|-------|
| Physics              | 10 | 15 |    25 |
| Chemistry            | 12 | 13 |    25 |
| Computer Science     | 13 | 12 |    25 |
| Math                 | 12 | 13 |    25 |
| **Core total**       | **47** | **53** | **100** |
| new_physics          | 16 | 24 |    40 |
| new_chemistry        | 16 | 18 |    34 |
| new_cs               | 16 | 17 |    33 |
| new_math             | 25 | 18 |    43 |
| **Candidate total**  | **73** | **77** | **150** |
| **Total**            | **120** | **130** | **250** |

## App

A React + Vite app with three tabs.

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
| `dist/api-static/results/<judge>/*.json` | one file per evaluated pair, per judge, plus `results/human/` |
| `dist/api-static/<judge>/ranking-records.json` | winners only, ranked in the browser, plus `human/` |

`src/api.js` picks between the two sources on `import.meta.env.DEV`, so the
deployed Figures, Outputs, and Benchmark tabs all read the committed results.
Bradley-Terry scoring is shared between the server and the browser
(`src/lib/rankings.js`), so a deployed ranking matches what `npm run dev` computes.

Preview the deployed build locally with `npm run build && npm run preview` — that
is a faithful read-only run, API and all.

**The catch this pays for:** `experiments/`, `screenshots/` and
`benchmark_results/` are deliberately *not* gitignored — about 70 MB of HTML plus
40 MB of captures, committed. Vercel builds from a clone, so anything the static
export reads at build time has to be in the repo. Ignore them and the build finds
no experiment HTML and the Outputs and Benchmark tabs come up empty; it logs a
warning when that happens. The alternative is `vercel --prod` from a working copy,
which uploads the working tree and honours `.vercelignore` instead of `.gitignore`.

## Credits

### Math figures

Figures are from:

> Anton, Bivens, and Davis. *Calculus, 10th Edition*
> © John Wiley & Sons

> OpenStax *Calculus Volume 3*
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/calculus-volume-3

> OpenStax *Precalculus 2e*
> © Rice University
> Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
> https://openstax.org/details/books/precalculus-2e

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

> Torralba, Isola, and Freeman. *Foundations of Computer Vision*
> © Antonio Torralba, Phillip Isola, and William Freeman
> Published by The MIT Press, 2024
> Licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)
> https://visionbook.mit.edu/

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
