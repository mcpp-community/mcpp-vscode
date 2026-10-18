import path from "node:path";
import { readProjectDeclarations, type ProjectDeclaration } from "../library/projectState";
import { readProjectSummary } from "./summary";

export interface GraphNode { key: string; name: string; version?: string; tags?: readonly string[]; dependencies?: number; depth: number; source: "project" | "manifest" | "index" | "unknown"; }
export interface GraphEdge { from: string; to: string; kind: string; conditional: boolean; constraint?: string; name?: string; declaration?: string; }
export interface DependencyGraph { nodes: GraphNode[]; edges: GraphEdge[]; limited: boolean; }
export interface GraphReader {
  manifest(root: string): Promise<string | undefined>;
  descriptor(id: string): { id: string; dependencies: ProjectDeclaration[]; resolved?: string; tags?: string[] } | undefined;
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
    const currentNode = graph.nodes.find((node) => node.key === current.key)!;
    currentNode.dependencies = declarations.length;
    if (text !== undefined) {
      const summary = readProjectSummary(current.root!, text.split(/\r?\n/));
      currentNode.version ??= summary.version;
      currentNode.tags = [currentNode.source === "project" ? "project" : "path", ...(summary.standard ? [summary.standard] : [])];
    }
    for (const dep of declarations) {
      const localRoot = dep.path && current.root ? path.resolve(current.root, dep.path) : undefined;
      const descriptor = dep.source ? undefined : reader.descriptor(dep.id);
      const key = localRoot ?? descriptor?.id ?? `unknown:${dep.id}`;
      if (!seen.has(key)) {
        if (seen.size >= 120) { graph.limited = true; continue; }
        seen.add(key);
        const localText = localRoot ? await reader.manifest(localRoot) : undefined;
        const local = localText === undefined ? undefined : readProjectSummary(localRoot!, localText.split(/\r?\n/));
        graph.nodes.push({ key, name: descriptor?.id ?? local?.name ?? dep.id, version: descriptor?.resolved ?? dep.version ?? local?.version, depth: current.depth + 1,
          tags: descriptor?.tags ?? (local ? ["path", ...(local.standard ? [local.standard] : [])] : ["unavailable"]),
          dependencies: descriptor?.dependencies.length ?? (localText === undefined ? undefined : readProjectDeclarations(localText).length),
          source: localRoot && localText !== undefined ? "manifest" : descriptor ? "index" : "unknown" });
        if (descriptor || localText !== undefined) { queue.push({ key, root: localRoot, declarations: descriptor?.dependencies, depth: current.depth + 1 }); }
      }
      const kind = dep.kind ?? (dep.dev ? "dev" : "normal");
      const edgeKey = JSON.stringify([current.key, key, kind, !!dep.conditional, dep.version]);
      if (!edges.has(edgeKey)) {
        if (edges.size >= 240) { graph.limited = true; continue; }
        edges.add(edgeKey);
        graph.edges.push({ from: current.key, to: key, kind, conditional: !!dep.conditional, constraint: dep.version, name: descriptor?.id ?? dep.id, declaration: dep.id });
      }
    }
  }
  return graph;
}

/** IDs are generated; every label is quoted and escaped, so manifest text cannot inject Mermaid syntax. */
export function graphMermaid(graph: DependencyGraph): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.key, `n${index}`]));
  const label = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[&"<>[\]{}|`\\#]/g, (char) => `#${char.charCodeAt(0)};`);
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  return ["flowchart LR", ...graph.nodes.map((node) => {
    const text = [node.name, ...(node.tags?.length ? [node.tags.slice(0, 2).join(" · ")] : []), `deps ${node.dependencies ?? "?"}`];
    return `  ${ids.get(node.key)}["${text.map(label).join("<br/>")}"]:::${node.source}`;
  }), ...graph.edges.map((edge) => {
    const target = nodes.get(edge.to)!;
    const version = edge.constraint ?? target.version;
    const coordinate = (edge.name ?? target.name) + (version ? `@${version}` : "");
    const text = coordinate + (edge.kind === "normal" ? "" : ` · ${edge.kind}`) + (edge.conditional ? " · conditional" : "");
    return `  ${ids.get(edge.from)} ${edge.conditional ? "-.-" : "--"}>|"${label(text)}"| ${ids.get(edge.to)}`;
  }), "  classDef unknown stroke-dasharray: 4 3"].join("\n");
}
