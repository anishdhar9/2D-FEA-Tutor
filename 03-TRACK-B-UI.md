# Track B — Canvas / UI

Read `01-CONTRACTS.md` first. This track owns `src/ui/*.js` and `index.html`. Build and
verify entirely against **mock** Model/Results JSON — do not wait for or import Track A's
solver. The whole point of the contract is that you don't need it to exist yet.

Create your own mock fixtures at `tests/fixtures/mock-*.json` matching the schema shapes
in `01-CONTRACTS.md`. For a head start, the exact numbers from the Phase 1/2 acceptance
tests in `02-TRACK-A-SOLVER.md` are valid to hardcode into a mock Results JSON — when
integration happens, the real solver should reproduce those same numbers, which becomes
a free visual sanity check ("does the rendered deformed shape look the same before and
after swapping mock data for the real solver").

---

## Phase 1 — Truss UI

### B1. Canvas + coordinate transform (`src/ui/canvas.js`)
- SVG root (not Canvas element — need per-node/element click targets for selection, see
  the work-shown panel this sets up for later).
- World-to-screen transform: model coordinates are meters, can be small (single digits)
  or large; pick a reasonable default viewBox and a zoom/pan control, don't hardcode a
  fixed pixel-per-meter scale that breaks on differently-sized models.

### B2. Node placement + element creation
- Click empty canvas: add a node, auto-assign id (`N1`, `N2`, ...).
- "Connect mode": click node A, then node B, creates a `truss` element between them,
  auto-assigned id (`e1`, `e2`, ...).
- Delete: click-select a node or element, delete key removes it (and any element that
  references a deleted node).

### B3. Support assignment
- Click a node, small popover: toggle pin (`ux,uy` fixed) / roller (`uy` fixed) / free.
  Render standard structural-engineering symbols (triangle hatch for pin, circle-on-line
  for roller) — not just a colored dot, this is a detail students will actually judge the
  tool on.

### B4. Load assignment
- Click a node: input `fx`, `fy` (N). Render as an arrow scaled to magnitude, labeled
  with the value.

### B5. Element properties
- Click an element: input `E`, `A`. Phase 1 only needs these two fields.

### B6. Serialize to Model JSON
- `getModel()` function producing exactly the schema in `01-CONTRACTS.md` from current
  UI state. This is the single function Track D will call to hand off to the solver —
  keep its output shape locked to the contract, don't invent extra fields.

### B7. Results rendering (against mock Results JSON)
- Deformed shape: overlay scaled displacement on the undeformed geometry, with a
  scale-factor slider (displacements are often too small to see at 1:1 — this is normal
  in structural FEA, not a bug, make it a UI feature not an apology).
- Color-code elements by `axialStress` sign/magnitude (e.g. blue = tension, red =
  compression, intensity by magnitude) — this needs to work off `elementForces` in the
  mock Results JSON, nothing solver-specific.
- Reaction arrows at supported nodes, scaled and labeled from `reactions`.

### B8. Results tables (`src/ui/results-panel.js`)
- Three tables from the Results JSON: displacements (node, ux, uy), reactions (node, rx,
  ry), element forces (element, axial force, stress). Straightforward JSON-to-table
  rendering, no computation here.

---

## Phase 2 — Frame UI additions

### B9. Element type + beam properties
- Element property panel (B5) gains a type selector (`truss` / `beam`). Selecting `beam`
  reveals an `I` input field.
- Support popover (B3) gains a "fixed" option (`ux,uy,rz` all true) alongside pin/roller,
  since beam elements make full fixity meaningful.

### B10. Distributed load input
- Click a `beam` element: input `wy` (N/m). Render as a series of small arrows along the
  element length (standard UDL representation), not just a single arrow.

### B11. Deformed shape for beam elements
- MVP: linear interpolation between the two end nodes' displaced positions is an
  acceptable simplification for Phase 2 — true cubic Hermite-interpolated bending shape
  between nodes is a nice-to-have, not a blocker, defer it rather than let it hold up the
  rest of Phase 2. Note this explicitly as a known simplification in a code comment so
  it isn't mistaken for a bug later.
- Reaction rendering (B7) extends to show moment reactions (`mz`) at fixed supports —
  a curved arrow or torque symbol, distinct from the force arrows already built.

### Mock fixtures to build against
Use the exact numbers from `02-TRACK-A-SOLVER.md`'s two acceptance tests (triangle truss
for Phase 1, propped cantilever for Phase 2) as your mock Results JSON. This means your
rendering work is checkable by eye against known-correct engineering answers (e.g. the
propped cantilever's deformed shape should visibly sag more near midspan than at the
roller end) even before any real solver code exists.
