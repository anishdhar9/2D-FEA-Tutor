// Assembly, inactive-DOF detection, partition, hand-rolled Gaussian
// elimination solve, reaction recovery (A4, A8).
//
// Handles mixed truss+beam models without a separate code path per element
// type — that's the payoff of the 3-DOF/node architecture decision in
// docs/01-CONTRACTS.md.

import {
  trussGeometry,
  trussLocalStiffness,
  trussGlobalStiffness,
} from './truss.js';
import {
  beamGeometry,
  beamLocalStiffness,
  beamRotationMatrix,
  beamGlobalStiffness,
  beamEquivalentNodalLoadsLocal,
} from './beam.js';
import {
  zerosMatrix,
  zerosVector,
  matTranspose,
  matVecMultiply,
  gaussianEliminationSolve,
} from './mat.js';

// K rows are either exactly zero (never scatter-added into) or dominated by
// stiffness terms many orders of magnitude larger than this — no fuzzy
// tolerance tuning needed.
const ZERO_ROW_TOL = 1e-9;

function scatterAdd(K, dofIndices, kElement) {
  for (let a = 0; a < dofIndices.length; a++) {
    for (let b = 0; b < dofIndices.length; b++) {
      K[dofIndices[a]][dofIndices[b]] += kElement[a][b];
    }
  }
}

function trussDofIndices(dof, el) {
  return [
    dof.globalIndex(el.nodeI, 'ux'),
    dof.globalIndex(el.nodeI, 'uy'),
    dof.globalIndex(el.nodeJ, 'ux'),
    dof.globalIndex(el.nodeJ, 'uy'),
  ];
}

function beamDofIndices(dof, el) {
  return [
    dof.globalIndex(el.nodeI, 'ux'),
    dof.globalIndex(el.nodeI, 'uy'),
    dof.globalIndex(el.nodeI, 'rz'),
    dof.globalIndex(el.nodeJ, 'ux'),
    dof.globalIndex(el.nodeJ, 'uy'),
    dof.globalIndex(el.nodeJ, 'rz'),
  ];
}

function buildSupportFlags(model, dof) {
  const flags = new Array(dof.numDofs).fill(false);
  for (const s of model.supports) {
    if (s.ux) flags[dof.globalIndex(s.node, 'ux')] = true;
    if (s.uy) flags[dof.globalIndex(s.node, 'uy')] = true;
    if (s.rz) flags[dof.globalIndex(s.node, 'rz')] = true;
  }
  return flags;
}

/**
 * Assemble the global system, detect inactive DOFs, partition into
 * free/fixed, solve for displacements, and recover reactions.
 *
 * @param {*} model normalized Model object (see src/model.js)
 * @param {*} dof result of buildDofMap(model)
 * @returns rich result object consumed by src/solver/index.js
 */
export function assembleAndSolve(model, dof) {
  const n = dof.numDofs;
  const K = zerosMatrix(n, n);
  const F = zerosVector(n);
  const elementLocalK = {};
  const elementGlobalK = {};

  const nodesById = new Map(model.nodes.map((nd) => [nd.id, nd]));

  // --- Assemble element stiffness ---
  for (const el of model.elements) {
    const nodeI = nodesById.get(el.nodeI);
    const nodeJ = nodesById.get(el.nodeJ);

    if (el.type === 'truss') {
      const { L, l, m } = trussGeometry(nodeI, nodeJ);
      const kLocal = trussLocalStiffness(el.E, el.A, L);
      const kGlobal = trussGlobalStiffness(el.E, el.A, L, l, m);
      elementLocalK[el.id] = kLocal;
      elementGlobalK[el.id] = kGlobal;
      scatterAdd(K, trussDofIndices(dof, el), kGlobal);
    } else if (el.type === 'beam') {
      const { L, c, s } = beamGeometry(nodeI, nodeJ);
      const kLocal = beamLocalStiffness(el.E, el.A, el.I, L);
      const T = beamRotationMatrix(c, s);
      const kGlobal = beamGlobalStiffness(kLocal, T);
      elementLocalK[el.id] = kLocal;
      elementGlobalK[el.id] = kGlobal;
      scatterAdd(K, beamDofIndices(dof, el), kGlobal);
    } else {
      throw new Error(`assemble: unknown element type "${el.type}" on element "${el.id}"`);
    }
  }

  // --- Applied nodal loads ---
  for (const load of model.loads.nodal) {
    F[dof.globalIndex(load.node, 'ux')] += load.fx ?? 0;
    F[dof.globalIndex(load.node, 'uy')] += load.fy ?? 0;
    F[dof.globalIndex(load.node, 'rz')] += load.mz ?? 0;
  }

  // --- Equivalent nodal loads from distributed loads (A7), beam only ---
  const elementsById = new Map(model.elements.map((e) => [e.id, e]));
  for (const d of model.loads.distributed) {
    const el = elementsById.get(d.element);
    const nodeI = nodesById.get(el.nodeI);
    const nodeJ = nodesById.get(el.nodeJ);
    const { L, c, s } = beamGeometry(nodeI, nodeJ);
    const eqLocal = beamEquivalentNodalLoadsLocal(d.wy, L, c, s);
    const T = beamRotationMatrix(c, s);
    const eqGlobal = matVecMultiply(matTranspose(T), eqLocal);
    const idx = beamDofIndices(dof, el);
    for (let i = 0; i < idx.length; i++) {
      F[idx[i]] += eqGlobal[i];
    }
  }

  // --- Inactive DOF detection (contracts doc rule): all-zero row in K ---
  const inactive = new Array(n).fill(false);
  for (let r = 0; r < n; r++) {
    let allZero = true;
    for (let c = 0; c < n; c++) {
      if (Math.abs(K[r][c]) > ZERO_ROW_TOL) {
        allZero = false;
        break;
      }
    }
    inactive[r] = allZero;
  }

  // --- Partition active DOFs into free/fixed per supports ---
  const supportFlags = buildSupportFlags(model, dof);
  const freeIdx = [];
  const fixedIdx = [];
  for (let i = 0; i < n; i++) {
    if (inactive[i]) continue;
    if (supportFlags[i]) {
      fixedIdx.push(i);
    } else {
      freeIdx.push(i);
    }
  }

  // --- Solve Kff * Uf = Ff (all prescribed/fixed displacements are 0 — the
  // Model schema has no support for nonzero prescribed displacement) ---
  const Kff = freeIdx.map((r) => freeIdx.map((c) => K[r][c]));
  const Ff = freeIdx.map((r) => F[r]);
  const Uf = gaussianEliminationSolve(Kff, Ff);

  const U = zerosVector(n);
  freeIdx.forEach((globalIdx, i) => {
    U[globalIdx] = Uf[i];
  });
  // Fixed and inactive DOFs stay at 0.

  // --- Reaction / residual recovery: R = K*U - F at every active DOF.
  // For a fixed DOF this is the true support reaction. For a free DOF this
  // is ~0 by construction (that's exactly the equilibrium equation the
  // solve satisfied). Inactive DOFs have an all-zero K row, so R is 0
  // there too without any special-casing. ---
  const R = zerosVector(n);
  for (let r = 0; r < n; r++) {
    if (inactive[r]) continue;
    let sum = 0;
    for (let c = 0; c < n; c++) {
      sum += K[r][c] * U[c];
    }
    R[r] = sum - F[r];
  }

  const inactiveDofs = [];
  for (let i = 0; i < n; i++) {
    if (inactive[i]) inactiveDofs.push(dof.keyForIndex(i));
  }

  const fixedNodeIds = new Set(fixedIdx.map((i) => dof.nodeDofForIndex(i).node));

  const partition = {
    free: freeIdx.map((i) => dof.keyForIndex(i)),
    fixed: fixedIdx.map((i) => dof.keyForIndex(i)),
  };

  return {
    K,
    F,
    U,
    R,
    inactive,
    inactiveDofs,
    partition,
    fixedNodeIds,
    elementLocalK,
    elementGlobalK,
  };
}
