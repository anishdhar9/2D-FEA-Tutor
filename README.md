# 2D FEA Tutor

Client-side (no backend) 2D finite element teaching tool: a direct-stiffness truss solver
(Phase 1) extended to beam/frame elements (Phase 2), with every intermediate matrix
inspectable — the "show your work" panel is the differentiator vs. black-box tools like
SkyCiv/Truzme/STRIAN.

See [`docs/00-OVERVIEW.md`](docs/00-OVERVIEW.md) for the full execution plan, and
[`docs/01-CONTRACTS.md`](docs/01-CONTRACTS.md) for the frozen Model/Results JSON schema
that the solver and UI both build against.

## Development

No build step, no dependencies — plain ES modules loaded directly by the browser and by
Node's built-in test runner.

```sh
node --test        # run the solver test suite (auto-discovers tests/*.test.js)
```

Open `index.html` via a local static server (ES module `<script>` tags require `http://`,
not `file://`), e.g.:

```sh
python3 -m http.server 8000
```
