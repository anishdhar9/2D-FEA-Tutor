// Single public entry point for the Track A solver.
//
// solveModel(model) takes an already-parsed Model JSON object and returns a
// Results JSON object exactly matching the schema in docs/01-CONTRACTS.md —
// this is the one function name the UI track and the integration step
// import, so the name and signature must stay exactly `solveModel(model)`.

import { normalizeModel } from '../model.js';
import { buildDofMap } from '../dofmap.js';
import { assembleAndSolve } from './assemble.js';
import { recoverElementForces } from './recover.js';

/**
 * @param {*} model Model JSON object (already parsed, not a file path)
 * @returns Results JSON object per docs/01-CONTRACTS.md
 */
export function solveModel(model) {
  const normalized = normalizeModel(model);
  const dof = buildDofMap(normalized);

  const {
    K,
    U,
    R,
    inactiveDofs,
    partition,
    fixedNodeIds,
    elementLocalK,
    elementGlobalK,
  } = assembleAndSolve(normalized, dof);

  const displacements = normalized.nodes.map((n) => ({
    node: n.id,
    ux: U[dof.globalIndex(n.id, 'ux')],
    uy: U[dof.globalIndex(n.id, 'uy')],
    rz: U[dof.globalIndex(n.id, 'rz')],
  }));

  // Reactions: only present for nodes with at least one fixed DOF.
  const reactions = normalized.nodes
    .filter((n) => fixedNodeIds.has(n.id))
    .map((n) => ({
      node: n.id,
      rx: R[dof.globalIndex(n.id, 'ux')],
      ry: R[dof.globalIndex(n.id, 'uy')],
      mz: R[dof.globalIndex(n.id, 'rz')],
    }));

  const elementForces = recoverElementForces(normalized, dof, U);

  return {
    displacements,
    reactions,
    elementForces,
    diagnostics: {
      inactiveDofs,
      dofNumbering: dof.dofNumbering,
      elementLocalK,
      elementGlobalK,
      globalK: K,
      partition,
    },
  };
}
