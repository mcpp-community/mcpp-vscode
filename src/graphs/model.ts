/** Shared presentation model; providers own package/module semantics and source access. */
export interface VisualNode {
  id: string;
  label: string;
  lines: string[];
  kind: "project" | "manifest" | "index" | "unknown";
  files?: string[];
  entry?: boolean;
}
export interface VisualEdge { from: string; to: string; label?: string; dashed?: boolean; }
export interface VisualGraph { nodes: VisualNode[]; edges: VisualEdge[]; roots: string[]; truncated?: boolean; }
export interface GraphExpansion { depth: number; expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>; focus?: string; }
export interface VisibleGraph extends VisualGraph { hidden: Map<string, number>; limited: boolean; }
export const GRAPH_BUDGET = { nodes: 150, edges: 300 } as const;

/** Choose a root for every directed component, including disconnected cycles. */
export function graphRoots(nodes: readonly VisualNode[], edges: readonly VisualEdge[], preferred: string[] = []): string[] {
  const adj = adjacency(edges), incoming = new Set(edges.map(edge => edge.to));
  const roots: string[] = [], seen = new Set<string>(), known = new Set(nodes.map(node => node.id));
  const visit = (id: string): void => {
    if (!known.has(id) || seen.has(id)) { return; }
    roots.push(id);
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) { continue; }
      seen.add(next);
      for (const child of adj.get(next) ?? []) { stack.push(child); }
    }
  };
  for (const id of preferred) { visit(id); }
  for (const node of nodes) { if (!incoming.has(node.id)) { visit(node.id); } }
  for (const node of nodes) { visit(node.id); }
  return roots;
}
function adjacency(edges: readonly VisualEdge[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const list = result.get(edge.from) ?? [];
    list.push(edge.to); result.set(edge.from, list);
  }
  return result;
}

/** Bound the subgraph BEFORE layout. Breadth first keeps wide and deep graphs navigable. */
export function visibleGraph(graph: VisualGraph, state: GraphExpansion, budget: { nodes: number; edges: number } = GRAPH_BUDGET): VisibleGraph {
  const adj = adjacency(graph.edges), known = new Set(graph.nodes.map(node => node.id));
  const seen = new Set<string>(), remaining = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  let limited = false;
  const add = (id: string, depth: number): void => {
    if (!known.has(id)) { return; }
    if (!seen.has(id)) {
      if (seen.size >= budget.nodes) { limited = true; return; }
      seen.add(id);
    }
    if ((remaining.get(id) ?? -1) >= depth) { return; }
    remaining.set(id, depth); queue.push([id, depth]);
  };
  if (state.focus && known.has(state.focus)) {
    add(state.focus, state.depth);
    // Context includes direct importers without recursively expanding their other dependencies.
    for (const edge of graph.edges) { if (edge.to === state.focus) { add(edge.from, 0); } }
  } else { for (const root of graph.roots) { add(root, state.depth); } }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [id, depth] = queue[cursor];
    if (state.collapsed.has(id) || (depth <= 0 && !state.expanded.has(id))) { continue; }
    for (const child of adj.get(id) ?? []) { add(child, Math.max(0, depth - 1)); }
  }
  const candidates = graph.edges.filter(edge => seen.has(edge.from) && seen.has(edge.to) && !state.collapsed.has(edge.from));
  const edges = candidates.slice(0, budget.edges);
  limited ||= candidates.length > edges.length;
  const rendered = new Map<string, Set<string>>();
  for (const edge of edges) { const list = rendered.get(edge.from) ?? new Set(); list.add(edge.to); rendered.set(edge.from, list); }
  const hidden = new Map<string, number>();
  for (const id of seen) {
    const missing = new Set((adj.get(id) ?? []).filter(child => !rendered.get(id)?.has(child)));
    if (missing.size) { hidden.set(id, missing.size); }
  }
  return { nodes: graph.nodes.filter(node => seen.has(node.id)), edges, roots: graph.roots, truncated: graph.truncated, hidden, limited };
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
