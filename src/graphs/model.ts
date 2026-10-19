/** Provider-independent graph. Containment edges belong only to presentation. */
export interface VisualNode {
  id: string; label: string; lines: string[];
  kind: "project" | "manifest" | "index" | "unknown";
  files?: string[]; entry?: boolean; virtual?: boolean;
}
export interface VisualEdge { from: string; to: string; label?: string; dashed?: boolean; containment?: boolean; }
export interface GraphGroup { id: string; label: string; nodes: string[]; }
export interface VisualGraph { nodes: VisualNode[]; edges: VisualEdge[]; roots: string[]; groups?: GraphGroup[]; truncated?: boolean; }
export interface GraphExpansion {
  depth: number; expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>; focus?: string;
  upstreamDepth?: number; localDepth?: ReadonlyMap<string, number>;
  upstreamLocalDepth?: ReadonlyMap<string, number>; upstreamCollapsed?: ReadonlySet<string>;
}
export interface VisibleGraph extends VisualGraph {
  hidden: Map<string, number>; hiddenParents: Map<string, number>; remainingDepth: Map<string, number>;
  upstreamRemaining: Map<string, number>; limited: boolean;
}
export const GRAPH_BUDGET = { nodes: 150, edges: 300 } as const;
export const INITIAL_GRAPH_BUDGET = { nodes: 60, edges: 80 } as const;

export function graphRoots(nodes: readonly VisualNode[], edges: readonly VisualEdge[], preferred: string[] = []): string[] {
  const adj = new Map<string, string[]>(), incoming = new Set(edges.map(edge => edge.to));
  for (const edge of edges) { const list = adj.get(edge.from) ?? []; list.push(edge.to); adj.set(edge.from, list); }
  const roots: string[] = [], seen = new Set<string>(), known = new Set(nodes.map(node => node.id));
  const visit = (id: string): void => {
    if (!known.has(id) || seen.has(id)) { return; }
    roots.push(id); const stack = [id];
    while (stack.length) {
      const next = stack.pop()!; if (seen.has(next)) { continue; } seen.add(next);
      for (const child of adj.get(next) ?? []) { stack.push(child); }
    }
  };
  for (const id of preferred) { visit(id); }
  for (const node of nodes) { if (!incoming.has(node.id)) { visit(node.id); } }
  for (const node of nodes) { visit(node.id); }
  return roots;
}

/** Cached per immutable provider snapshot; camera/selection never rebuild these indexes. */
const indexes = new WeakMap<VisualGraph, { nodes: Map<string, VisualNode>; out: Map<string, VisualEdge[]>; incoming: Map<string, VisualEdge[]> }>();
function graphIndex(graph: VisualGraph) {
  let index = indexes.get(graph);
  if (!index) {
    index = { nodes: new Map(graph.nodes.map(node => [node.id, node])), out: new Map(), incoming: new Map() };
    for (const edge of graph.edges) {
      const out = index.out.get(edge.from) ?? []; out.push(edge); index.out.set(edge.from, out);
      const incoming = index.incoming.get(edge.to) ?? []; incoming.push(edge); index.incoming.set(edge.to, incoming);
    }
    indexes.set(graph, index);
  }
  return index;
}

/** Nodes enter with their connecting edge, so an edge budget cannot strand new nodes. */
export function visibleGraph(graph: VisualGraph, state: GraphExpansion, budget: { nodes: number; edges: number } = GRAPH_BUDGET): VisibleGraph {
  const index = graphIndex(graph), seen = new Set<string>(), accepted = new Set<VisualEdge>();
  const remainingDepth = new Map<string, number>(), upstreamRemaining = new Map<string, number>();
  let limited = false;
  const addRoot = (id: string): boolean => {
    if (!index.nodes.has(id)) { return false; }
    if (!seen.has(id) && seen.size >= budget.nodes) { limited = true; return false; }
    seen.add(id); return true;
  };
  const walk = (seeds: string[], upstream: boolean, base: number, nodeLimit: number, edgeLimit = budget.edges): void => {
    const remaining = upstream ? upstreamRemaining : remainingDepth;
    const local = upstream ? state.upstreamLocalDepth : state.localDepth;
    const collapsed = upstream ? state.upstreamCollapsed : state.collapsed;
    const queue: Array<[string, number]> = seeds.map(id => [id, base]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [id, depth] = queue[cursor];
      let effective = Math.max(depth, local?.get(id) ?? 0);
      if (!upstream && state.expanded.has(id)) { effective = Math.max(effective, 1); }
      if ((remaining.get(id) ?? -1) >= effective) { continue; }
      remaining.set(id, effective);
      if (collapsed?.has(id)) { continue; }
      for (const edge of (upstream ? index.incoming : index.out).get(id) ?? []) {
        if (upstream && edge.containment) { continue; }
        if (effective <= 0 && !edge.containment) { continue; }
        const next = upstream ? edge.from : edge.to;
        if (!index.nodes.has(next)) { continue; }
        if ((!accepted.has(edge) && accepted.size >= edgeLimit) || (!seen.has(next) && seen.size >= nodeLimit)) { limited = true; continue; }
        accepted.add(edge); seen.add(next);
        queue.push([next, edge.containment ? effective : Math.max(0, effective - 1)]);
      }
    }
  };
  const focused = state.focus && index.nodes.has(state.focus) ? state.focus : undefined;
  if (focused) {
    addRoot(focused);
    // Reserve parent context, but never let a high fan-in consume the whole view.
    const parentBudget = Math.min(20, Math.max(0, Math.floor((budget.nodes - 1) / 3)));
    walk([focused], true, state.upstreamDepth ?? 1, 1 + parentBudget, Math.floor(budget.edges / 3));
    walk([focused], false, state.depth, budget.nodes);
    // Explicit local exploration also works on nodes first reached from the other direction.
    for (const id of state.localDepth?.keys() ?? []) { if (seen.has(id)) { walk([id], false, 0, budget.nodes); } }
    for (const id of state.upstreamLocalDepth?.keys() ?? []) { if (seen.has(id)) { walk([id], true, 0, budget.nodes); } }
  } else {
    // Process a component before admitting more roots; many tests cannot starve every edge.
    if (graph.roots.every(id => index.nodes.get(id)?.virtual)) { for (const root of graph.roots) { addRoot(root); } }
    for (const root of graph.roots) { if (addRoot(root)) { walk([root], false, state.depth, budget.nodes); } }
  }
  const hidden = new Map<string, number>(), hiddenParents = new Map<string, number>();
  for (const id of seen) {
    const children = new Set((index.out.get(id) ?? []).filter(edge => !accepted.has(edge)).map(edge => edge.to));
    const parents = new Set((index.incoming.get(id) ?? []).filter(edge => !edge.containment && !accepted.has(edge)).map(edge => edge.from));
    if (children.size) { hidden.set(id, children.size); }
    if (parents.size) { hiddenParents.set(id, parents.size); }
  }
  return { nodes: graph.nodes.filter(node => seen.has(node.id)), edges: graph.edges.filter(edge => accepted.has(edge)), roots: focused ? [focused] : graph.roots,
    truncated: graph.truncated, hidden, hiddenParents, remainingDepth, upstreamRemaining, limited };
}

/** Presentation groups page entries without consuming import depth. */
export function groupedGraph(graph: VisualGraph, activeGroup?: string, offset = 0): VisualGraph {
  if (!graph.groups?.length) { return graph; }
  const groups = graph.groups;
  const nodes: VisualNode[] = groups.map(group => ({ id: group.id, label: group.label, lines: [String(group.nodes.length)], kind: "manifest", virtual: true }));
  const edges: VisualEdge[] = [];
  for (const group of groups) {
    if (activeGroup ? group.id !== activeGroup : group.id !== groups[0].id) { continue; }
    for (const id of group.nodes.slice(offset, offset + 20)) { edges.push({ from: group.id, to: id, dashed: true, containment: true }); }
  }
  return { ...graph, nodes: [...nodes, ...graph.nodes], edges: [...edges, ...graph.edges], roots: groups.map(group => group.id) };
}

export function mermaidGraph(graph: VisibleGraph): { source: string; nodeIds: string[] } {
  const nodeIds = graph.nodes.map(node => node.id), ids = new Map(nodeIds.map((id, index) => [id, `n${index}`]));
  const label = (value: string): string => value.replace(/[\r\n]/g, " ").replace(/[&"<>[\]{}|`\\#]/g, char => `#${char.charCodeAt(0)};`);
  const source = ["flowchart LR", ...graph.nodes.map(node => {
    const hidden = graph.hidden.get(node.id);
    const text = [node.label, ...node.lines, ...(hidden ? [`＋${hidden}`] : [])].map(label).join("<br/>");
    return `  ${ids.get(node.id)}["${text}"]:::${node.kind}`;
  }), ...graph.edges.map(edge => `  ${ids.get(edge.from)} ${edge.dashed ? "-.-" : "--"}>${edge.label ? `|"${label(edge.label)}"|` : ""} ${ids.get(edge.to)}`), "  classDef unknown stroke-dasharray: 4 3"].join("\n");
  return { source, nodeIds };
}
