// Model loader + validator (A1).
//
// Takes an already-parsed Model JSON object (never a file path — this module
// does no file I/O, so it stays usable from both Node's test runner and a
// browser <script type="module"> context) and validates it against the
// schema frozen in docs/01-CONTRACTS.md. Throws a descriptive Error on any
// validation failure; never fails silently.

const VALID_ELEMENT_TYPES = new Set(['truss', 'beam']);

/**
 * Validate a raw Model JSON object. Throws a descriptive Error on the first
 * problem found. Returns a list of non-fatal warning strings (e.g. "I
 * supplied on a truss element") for callers that want to surface them.
 *
 * @param {*} model
 * @returns {string[]} warnings
 */
export function validateModel(model) {
  const warnings = [];

  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error('Model must be a JSON object');
  }
  if (!Array.isArray(model.nodes)) {
    throw new Error('Model.nodes must be an array');
  }
  if (!Array.isArray(model.elements)) {
    throw new Error('Model.elements must be an array');
  }
  if (model.supports !== undefined && !Array.isArray(model.supports)) {
    throw new Error('Model.supports must be an array when present');
  }

  // --- Nodes ---
  const nodeIds = new Set();
  for (const [i, node] of model.nodes.entries()) {
    if (!node || typeof node !== 'object') {
      throw new Error(`nodes[${i}] must be an object`);
    }
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new Error(`nodes[${i}] must have a non-empty string id`);
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`Duplicate node id: "${node.id}"`);
    }
    nodeIds.add(node.id);
    if (typeof node.x !== 'number' || !Number.isFinite(node.x)) {
      throw new Error(`Node "${node.id}" must have a finite numeric x`);
    }
    if (typeof node.y !== 'number' || !Number.isFinite(node.y)) {
      throw new Error(`Node "${node.id}" must have a finite numeric y`);
    }
  }

  // --- Elements ---
  const elementIds = new Set();
  for (const [i, el] of model.elements.entries()) {
    if (!el || typeof el !== 'object') {
      throw new Error(`elements[${i}] must be an object`);
    }
    if (typeof el.id !== 'string' || el.id.length === 0) {
      throw new Error(`elements[${i}] must have a non-empty string id`);
    }
    if (elementIds.has(el.id)) {
      throw new Error(`Duplicate element id: "${el.id}"`);
    }
    elementIds.add(el.id);

    if (!VALID_ELEMENT_TYPES.has(el.type)) {
      throw new Error(
        `Element "${el.id}" has unknown type "${el.type}" (expected "truss" or "beam")`
      );
    }
    if (typeof el.nodeI !== 'string' || !nodeIds.has(el.nodeI)) {
      throw new Error(`Element "${el.id}" nodeI references unknown node "${el.nodeI}"`);
    }
    if (typeof el.nodeJ !== 'string' || !nodeIds.has(el.nodeJ)) {
      throw new Error(`Element "${el.id}" nodeJ references unknown node "${el.nodeJ}"`);
    }
    if (el.nodeI === el.nodeJ) {
      throw new Error(`Element "${el.id}" cannot use the same node for nodeI and nodeJ`);
    }
    if (typeof el.E !== 'number' || !Number.isFinite(el.E)) {
      throw new Error(`Element "${el.id}" must have a finite numeric E`);
    }
    if (typeof el.A !== 'number' || !Number.isFinite(el.A)) {
      throw new Error(`Element "${el.id}" must have a finite numeric A`);
    }
    if (el.type === 'beam') {
      if (typeof el.I !== 'number' || !Number.isFinite(el.I)) {
        throw new Error(`Beam element "${el.id}" must have a finite numeric I`);
      }
    } else if (el.type === 'truss' && el.I !== undefined) {
      // Per contracts doc: warn, don't error — truss elements ignore I.
      warnings.push(`Truss element "${el.id}" has an "I" field; it is ignored by truss elements.`);
    }
  }

  // --- Supports ---
  const supports = model.supports ?? [];
  for (const [i, s] of supports.entries()) {
    if (!s || typeof s !== 'object') {
      throw new Error(`supports[${i}] must be an object`);
    }
    if (typeof s.node !== 'string' || !nodeIds.has(s.node)) {
      throw new Error(`supports[${i}] references unknown node "${s.node}"`);
    }
  }

  // --- Loads ---
  const loads = model.loads ?? {};
  if (typeof loads !== 'object' || Array.isArray(loads)) {
    throw new Error('Model.loads must be an object when present');
  }
  const nodal = loads.nodal ?? [];
  if (!Array.isArray(nodal)) {
    throw new Error('Model.loads.nodal must be an array when present');
  }
  for (const [i, l] of nodal.entries()) {
    if (!l || typeof l !== 'object') {
      throw new Error(`loads.nodal[${i}] must be an object`);
    }
    if (typeof l.node !== 'string' || !nodeIds.has(l.node)) {
      throw new Error(`loads.nodal[${i}] references unknown node "${l.node}"`);
    }
  }
  const distributed = loads.distributed ?? [];
  if (!Array.isArray(distributed)) {
    throw new Error('Model.loads.distributed must be an array when present');
  }
  const elementsById = new Map(model.elements.map((e) => [e.id, e]));
  for (const [i, d] of distributed.entries()) {
    if (!d || typeof d !== 'object') {
      throw new Error(`loads.distributed[${i}] must be an object`);
    }
    if (typeof d.element !== 'string' || !elementIds.has(d.element)) {
      throw new Error(`loads.distributed[${i}] references unknown element "${d.element}"`);
    }
    const el = elementsById.get(d.element);
    if (el.type !== 'beam') {
      throw new Error(
        `loads.distributed[${i}] targets element "${d.element}" of type "${el.type}"; ` +
          'distributed loads are only valid on "beam" elements'
      );
    }
    if (typeof d.wy !== 'number' || !Number.isFinite(d.wy)) {
      throw new Error(`loads.distributed[${i}] must have a finite numeric wy`);
    }
  }

  return warnings;
}

/**
 * Validate and normalize a raw Model JSON object: fills in defaults for
 * optional collections (supports, loads.nodal, loads.distributed) so
 * downstream code never has to guard against `undefined`.
 *
 * @param {*} rawModel
 * @returns normalized model object
 */
export function normalizeModel(rawModel) {
  const warnings = validateModel(rawModel);
  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[2D-FEA-Tutor model] ${w}`);
  }

  return {
    meta: rawModel.meta ?? { units: 'SI' },
    nodes: rawModel.nodes,
    elements: rawModel.elements,
    supports: rawModel.supports ?? [],
    loads: {
      nodal: rawModel.loads?.nodal ?? [],
      distributed: rawModel.loads?.distributed ?? [],
    },
  };
}
