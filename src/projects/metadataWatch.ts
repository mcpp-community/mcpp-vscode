import { statSync } from "node:fs";
import path from "node:path";

/** Two cheap file stamps provide a fallback when the editor's watcher drops events. */
export class ProjectMetadataWatch {
  private versions = new Map<string, string>();
  public constructor(private readonly version: (file: string) => string = file => {
    try { const stat = statSync(file, {bigint:true}); return `${stat.ino}:${stat.size}:${stat.mtimeNs}`; }
    catch { return "unavailable"; }
  }) {}
  public capture(root?: string): void {
    this.versions.clear();
    if (root) { for (const name of ["mcpp.toml", "mcpp.lock"]) { const file = path.join(root,name); this.versions.set(file,this.version(file)); } }
  }
  public changes(visible = true): string[] {
    if (!visible) { return []; }
    const changed: string[] = [];
    for (const [file,previous] of this.versions) {
      const next=this.version(file);
      if(next!==previous){this.versions.set(file,next);changed.push(file);}
    }
    return changed;
  }
}
