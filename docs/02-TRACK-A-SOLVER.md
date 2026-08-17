# Track A — Solver Engine

Read `01-CONTRACTS.md` first. This track owns `src/model.js`, `src/dofmap.js`,
`src/solver/*.js`. Pure logic, zero DOM dependency, fully testable with `node --test`.
Do not touch `src/ui/*`.

Test runner: use Node's built-in `node:test` + `node:assert/strict` — no dependency
needed, keeps this track buildable/testable in complete isolation.

---

## Phase 1 — Truss solver

### A1. Model loader + validator (`src/model.js`)
- Parse a Model JSON per the schema in `01-CONTRACTS.md`.
- Validate: every `nodeI`/`nodeJ` in `elements` references an existing node id; every
  `node` in `supports` references an existing node id; no duplicate node/element ids.
- Throw a descriptive error on validation failure (don't fail silently).

### A2. Global DOF numbering (`src/dofmap.js`)
- Allocate 3 DOF/node (`ux`, `uy`, `rz`) per the architecture decision in the contracts
  doc, in node array order.
- Export a bidirectional map: `nodeId+dofName -> global index` and back.

### A3. Truss element stiffness (`src/solver/truss.js`)
Local-to-global element stiffness, direction cosines `l = (xJ-xI)/L`, `m = (yJ-yI)/L`:

```
k = (E*A/L) * [[ l*l,  l*m, -l*l, -l*m],
               [ l*m,  m*m, -l*m, -m*m],
               [-l*l, -l*m,  l*l,  l*m],
               [-l*m, -m*m,  l*m,  m*m]]
```
This 4x4 populates the `ux`,`uy` DOF at each of the element's two nodes. `rz` rows/cols
untouched by this element.

### A4. Assembly, inactive-DOF detection, partition, solve (`src/solver/assemble.js`)
- Scatter-add each element's global stiffness into the full system K (size = 3 × node count).
- Detect inactive DOFs (all-zero row, see contracts doc rule) — exclude from solve, record
  in `diagnostics.inactiveDofs`.
- Partition remaining DOFs into free/fixed per `supports`. Solve `Kff*Uf = Ff` via Gaussian
  elimination (hand-rolled, not a library call — small systems, and this keeps the solve
  steps inspectable for the future "show your work" panel instead of hidden inside a
  matrix-library black box).
- Recover reactions: `Fc = Kcf*Uf + Kcc*Uc`.

### A5. Element force recovery (`src/solver/recover.js`)
- Truss: axial force `N = (EA/L) * (elongation)`, stress `= N/A`. Tension positive.

### Phase 1 acceptance test — triangle truss
Nodes: A(0,0), B(4,0), C(2,3). Elements: e1(A-B), e2(B-C), e3(A-C), all `E=200e9`,
`A=500e-6`. Supports: A pinned (`ux,uy` fixed), B roller (`uy` fixed). Load at C:
`fx=4000, fy=-10000`.

Expected (tolerance: relative error < 1e-6, or absolute < 1e-6 N / 1e-9 m — floating
point solve, not hand-calc rounding, so this should match tight):

| Quantity | Expected value |
|---|---|
| `U_C.ux` | 3.4102749957e-4 m |
| `U_C.uy` | -3.3151203656e-4 m |
| `U_B.ux` | 2.1333333333e-4 m |
| `R_A.rx` | -4000.0 N |
| `R_A.ry` | 2000.0 N |
| `R_B.ry` | 8000.0 N |
| `e1 (A-B) axialForce` | 5333.333333 N (tension) |
| `e2 (B-C) axialForce` | -9614.803401 N (compression) |
| `e3 (A-C) axialForce` | -2403.700850 N (compression) |
| `e1 axialStress` | 10666666.666667 Pa |
| `e2 axialStress` | -19229606.802475 Pa |
| `e3 axialStress` | -4807401.700619 Pa |

Also assert global equilibrium: sum of all reaction forces + applied nodal forces = 0
in both x and y, to within 1e-6 N. This catches assembly/sign-convention bugs that could
coincidentally still pass the point-value checks above.

(Canonical machine-readable version of this fixture: `tests/fixtures/truss-triangle.*.json`,
owned by Track C — use it once available, the table above is enough to build against now.)

---

## Phase 2 — Beam solver

### A6. Beam element stiffness (`src/solver/beam.js`)
Local 6×6, DOF order `[uI, vI, θI, uJ, vJ, θJ]` (axial + Euler-Bernoulli bending combined):

```
k = [[ EA/L,        0,         0,     -EA/L,        0,         0],
     [    0,   12EI/L^3,   6EI/L^2,       0,  -12EI/L^3,   6EI/L^2],
     [    0,    6EI/L^2,     4EI/L,       0,   -6EI/L^2,     2EI/L],
     [-EA/L,        0,         0,      EA/L,        0,         0],
     [    0,  -12EI/L^3,  -6EI/L^2,       0,   12EI/L^3,  -6EI/L^2],
     [    0,    6EI/L^2,     2EI/L,       0,   -6EI/L^2,     4EI/L]]
```
Transform to global with 6×6 rotation `T` built from two 3×3 blocks
`[[c,s,0],[-s,c,0],[0,0,1]]`, `c=cosθ`, `s=sinθ` of the element's orientation.
`k_global = T^T * k * T`.

### A7. Equivalent nodal loads for distributed load
For a UDL `wy` (N/m, global Y direction) over a beam element of length `L`, y-up
convention, consistent nodal load vector on `[vI, θI, vJ, θJ]`:

```
F_eq = [ wy*L/2,  wy*L^2/12,  wy*L/2,  -wy*L^2/12 ]
```
Add these directly into the global load vector at assembly time — do not require the
model author to manually convert distributed loads to nodal loads upstream.

### A8. Extend assembly for mixed truss+beam models
Same `assemble.js` from A4 should handle elements of either type without modification —
this is the payoff of the 3-DOF/node decision. If it doesn't, the DOF numbering or
inactive-DOF detection from A2/A4 has a bug; fix there, don't special-case Phase 2 into
a separate assembly path.

### A9. Beam element force recovery
Recover local end forces via `f_local = k_local · T · u_element_global` (subtract
equivalent nodal loads back out before reporting, since those were an analysis device,
not a physical end force). Report axial force, shear, and moment at both ends per the
Results schema's `elementForces` beam shape.

### Phase 2 acceptance test — propped cantilever
Single beam element, node A(0,0) fixed (`ux,uy,rz` all true), node B(4,0) roller
(`uy` true only). `E=200e9`, `A=500e-6` (irrelevant to this test — no axial load),
`I=8e-6`. Distributed load on the element: `wy=-10000` (UDL, 10 kN/m downward).

Expected (this is a classic result — single-element FEM with consistent nodal loads
should reproduce the closed-form propped-cantilever solution *exactly*, not
approximately; if your result is off by more than numerical tolerance, the equivalent
load formula in A7 or the sign convention is wrong, not the benchmark):

| Quantity | Expected value | Closed-form check |
|---|---|---|
| `θ_B` (rz at B) | 0.0083333333 rad | `wL^3/48EI` with `w=10000,L=4,EI=1.6e6` |
| `R_A.ry` | 25000.0 N | `5wL/8 = 25 kN` |
| `R_A.mz` | 20000.0 N·m | `wL^2/8 = 20 kN·m` (fixed-end moment) |
| `R_B.ry` | 15000.0 N | `3wL/8 = 15 kN` |

Also assert `R_A.ry + R_B.ry = wL = 40000 N` and this result is **independent of the
specific `E`/`I` values chosen** (rerun with a different `I` and confirm reactions don't
change — only `θ_B` should) — that invariance is itself a correctness check on a
statically-indeterminate single-element solve.
