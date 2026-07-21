# Benchmark Figures

A static benchmark dataset of hand-labeled scientific figures, categorized by subject and dimensionality (2d vs. 3d). Comes with a small browser-based viewer for browsing and filtering the set.

## Dataset

Figures live in `public/images/{subject}/{type}/{stem}{ext}` and are indexed by `public/figures.json`. Each manifest entry has the shape:

```json
{ "stem": "CNX_Chem_01_01_FuelCell", "subject": "chemistry", "type": "2d", "ext": ".jpg" }
```

- **`subject`**: `physics` | `chemistry` | `cs` | `math`
- **`type`**: `2d` (flat diagrams, schematics, graphs) | `3d` (spatial/volumetric illustrations)

Current counts:

| Subject          | 2d | 3d | Total |
|------------------|----|----|-------|
| Physics          |  6 | 16 |    22 |
| Chemistry        | 19 | 22 |    41 |
| Computer Science | 13 | 12 |    25 |
| Math             | 14 | 14 |    28 |
| **Total**        | **52** | **64** | **116** |

## Viewer

A React + Vite app for browsing the dataset. Figures can be filtered by subject and type.

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

## Credits

### Math figures

Figures are from:

> Anton, Bivens, and Davis. *Calculus, 10th Edition*
> © John Wiley & Sons

### Chemistry figures

Figures are from:

> OpenStax *Chemistry 2e*
> © Rice University
> Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
> https://openstax.org/details/books/chemistry-2e

### Computer Science figures

Figures are from:

> Prince, Simon J.D. *Understanding Deep Learning*
> Licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)
> https://udlbook.github.io/udlbook/

### Physics figures

Figures are from:

> Torralba, Isola, and Freeman. *Foundations of Computer Vision*
> © Antonio Torralba, Phillip Isola, and William Freeman
> Published by The MIT Press, 2024
> Licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)
> https://visionbook.mit.edu/
