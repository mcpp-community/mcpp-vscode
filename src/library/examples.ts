import snapshot from "../../data/library-examples.json";
import { createHash } from "node:crypto";
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
export class ExampleDocuments {
  private readonly documents = new Map<string, string>();
  constructor(private readonly captured?: (uri: string) => void) {}
  capture(file: CodeFile): string {
    const digest = createHash("sha256").update(file.text).digest("hex");
    const uri = `${EXAMPLE_SCHEME}:/${file.path.split("/").map(encodeURIComponent).join("/")}?snapshot=${digest}`;
    this.documents.set(digest, file.text);
    this.captured?.(uri);
    return uri;
  }
  read(uri: string): string | undefined {
    try {
      const digest = /[?&]snapshot=([a-f0-9]{64})(?:$|&)/.exec(decodeURIComponent(uri))?.[1];
      return digest ? this.documents.get(digest) : undefined;
    } catch { return undefined; }
  }
}
