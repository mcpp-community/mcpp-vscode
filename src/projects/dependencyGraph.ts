import path from "node:path";
import { readProjectDeclarations, type ProjectDeclaration } from "../library/projectState";

export interface GraphNode { key: string; name: string; version?: string; depth: number; source: "project" | "manifest" | "index" | "unknown"; }
export interface GraphEdge { from: string; to: string; kind: string; conditional: boolean; constraint?: string; }
export interface DependencyGraph { nodes: GraphNode[]; edges: GraphEdge[]; limited: boolean; }
export interface GraphReader {
  manifest(root: string): Promise<string | undefined>;
  descriptor(id: string): { id: string; dependencies: ProjectDeclaration[]; resolved?: string } | undefined;
}

/** Project is depth zero; traverse at most three dependency hops, preserving shared/cyclic edges. */
export async function buildDependencyGraph(root: string, name: string, reader: GraphReader, maxDepth = 3): Promise<DependencyGraph> {
  const graph: DependencyGraph = { nodes: [{ key: root, name, depth: 0, source: "project" }], edges: [], limited: false };
  const queue: Array<{ key: string; root?: string; declarations?: ProjectDeclaration[]; depth: number }> = [{ key: root, root, depth: 0 }];
  const seen = new Set([root]);
  const edges = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) { continue; }
    const text = current.root ? await reader.manifest(current.root) : undefined;
    const declarations = current.declarations ?? (text === undefined ? [] : readProjectDeclarations(text));
    for (const dep of declarations) {
      const localRoot = dep.path && current.root ? path.resolve(current.root, dep.path) : undefined;
      const descriptor = dep.source ? undefined : reader.descriptor(dep.id);
      const key = localRoot ?? descriptor?.id ?? `unknown:${dep.id}`;
      if (!seen.has(key)) {
        if (seen.size >= 120) { graph.limited = true; continue; }
        seen.add(key);
        const localText = localRoot ? await reader.manifest(localRoot) : undefined;
        graph.nodes.push({ key, name: descriptor?.id ?? dep.id, version: descriptor?.resolved ?? dep.version, depth: current.depth + 1,
          source: localRoot && localText !== undefined ? "manifest" : descriptor ? "index" : "unknown" });
        if (descriptor || localText !== undefined) { queue.push({ key, root: localRoot, declarations: descriptor?.dependencies, depth: current.depth + 1 }); }
      }
      const kind = dep.kind ?? (dep.dev ? "dev" : "normal");
      const edgeKey = JSON.stringify([current.key, key, kind, !!dep.conditional, dep.version]);
      if (!edges.has(edgeKey)) {
        if (edges.size >= 240) { graph.limited = true; continue; }
        edges.add(edgeKey);
        graph.edges.push({ from: current.key, to: key, kind, conditional: !!dep.conditional, constraint: dep.version });
      }
    }
  }
  return graph;
}

/** IDs are generated; every label is quoted and escaped, so manifest text cannot inject Mermaid syntax. */
export function graphMermaid(graph: DependencyGraph): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.key, `n${index}`]));
  const label = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[&"<>[\]{}|`\\#]/g, (char) => `#${char.charCodeAt(0)};`);
  return ["flowchart LR", ...graph.nodes.map((node) => `  ${ids.get(node.key)}["${label(node.name + (node.version ? ` @ ${node.version}` : ""))}"]:::${node.source}`),
    ...graph.edges.map((edge) => `  ${ids.get(edge.from)} ${edge.conditional ? "-.-" : "--"}>|${label((edge.kind === "normal" ? "dep" : edge.kind) + (edge.constraint ? ` @ ${edge.constraint}` : "") + (edge.conditional ? " · conditional" : ""))}| ${ids.get(edge.to)}`),
    "  classDef unknown stroke-dasharray: 4 3", "  classDef project stroke-width: 3px", "  classDef manifest stroke-width: 2px", "  classDef index stroke-width: 1px"].join("\n");
}
