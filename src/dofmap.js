// Global DOF numbering (A2).
//
// Per the architecture decision in docs/01-CONTRACTS.md, every node gets 3
// DOF — ux, uy, rz — in node array order, even in Phase 1 where truss
// elements only ever populate the ux/uy sub-block. This avoids renumbering
// every node when Phase 2 introduces beam elements.
//
// Pure computation only — no Node-only APIs — so this module can also be
// imported directly by browser <script type="module"> code later.

export const DOF_NAMES = ['ux', 'uy', 'rz'];
export const DOFS_PER_NODE = DOF_NAMES.length;

/**
 * Build a bidirectional map between (nodeId, dofName) pairs and global DOF
 * indices, for a model whose nodes have already been validated.
 *
 * @param {{nodes: {id: string}[]}} model
 * @returns {{
 *   nodeIds: string[],
 *   numNodes: number,
 *   numDofs: number,
 *   globalIndex: (nodeId: string, dofName: string) => number,
 *   keyForIndex: (index: number) => string,
 *   nodeDofForIndex: (index: number) => {node: string, dof: string},
 *   dofNumbering: Record<string, {ux: number, uy: number, rz: number}>,
 * }}
 */
export function buildDofMap(model) {
  const nodeIds = model.nodes.map((n) => n.id);
  const nodeOrder = new Map(nodeIds.map((id, i) => [id, i]));
  const numNodes = nodeIds.length;
  const numDofs = numNodes * DOFS_PER_NODE;

  function globalIndex(nodeId, dofName) {
    const nodeIdx = nodeOrder.get(nodeId);
    if (nodeIdx === undefined) {
      throw new Error(`dofmap: unknown node id "${nodeId}"`);
    }
    const dofIdx = DOF_NAMES.indexOf(dofName);
    if (dofIdx === -1) {
      throw new Error(`dofmap: unknown dof name "${dofName}" (expected one of ${DOF_NAMES.join(', ')})`);
    }
    return nodeIdx * DOFS_PER_NODE + dofIdx;
  }

  function nodeDofForIndex(index) {
    const nodeIdx = Math.floor(index / DOFS_PER_NODE);
    const dofIdx = index % DOFS_PER_NODE;
    return { node: nodeIds[nodeIdx], dof: DOF_NAMES[dofIdx] };
  }

  function keyForIndex(index) {
    const { node, dof } = nodeDofForIndex(index);
    return `${node}.${dof}`;
  }

  const dofNumbering = {};
  for (const id of nodeIds) {
    dofNumbering[id] = {
      ux: globalIndex(id, 'ux'),
      uy: globalIndex(id, 'uy'),
      rz: globalIndex(id, 'rz'),
    };
  }

  return {
    nodeIds,
    numNodes,
    numDofs,
    globalIndex,
    keyForIndex,
    nodeDofForIndex,
    dofNumbering,
  };
}
