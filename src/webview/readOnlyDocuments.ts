import { createHash } from "node:crypto";

/** Content-addressed text documents. A content provider exposes them without a writable filesystem. */
export class ReadOnlyDocuments {
  private readonly documents = new Map<string, string>();
  constructor(private readonly scheme: string, private readonly captured?: (uri: string) => void) {}
  capture(file: { path: string; text: string }): string {
    const digest = createHash("sha256").update(file.text).digest("hex");
    const uri = `${this.scheme}:/${file.path.split(/[\\/]/).map(encodeURIComponent).join("/")}?snapshot=${digest}`;
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
