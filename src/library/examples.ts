import snapshot from "../../data/library-examples.json";
import { ReadOnlyDocuments } from "../webview/readOnlyDocuments";
import { exampleCatalog, type CodeFile } from "./indexModel";

const catalog = exampleCatalog(snapshot.projects.map((project) => ({
  project: project.project, text: project.text, sources: project.files.map((file) => file.path),
})));
const files = new Map(snapshot.projects.flatMap((project) => project.files.map((file) => [file.path, file.text] as const)));

/** Official-index fallback only. Local checkouts use their own current tests. */
export function bundledExample(id: string): { project: string; files: CodeFile[]; commit: string } | undefined {
  const ref = catalog.get(id);
  return ref ? { project: ref.project, commit: snapshot.commit, files: ref.paths.map((path) => ({ path, text: files.get(path)! })) } : undefined;
}

export function bundledExampleText(path: string): string | undefined { return files.get(path.replace(/^\//, "")); }
export const EXAMPLE_SCHEME = "mcpp-example";

/** Immutable virtual documents keep local and bundled index sources equally read-only. */
export class ExampleDocuments extends ReadOnlyDocuments {
  constructor(captured?: (uri: string) => void) { super(EXAMPLE_SCHEME, captured); }
}
