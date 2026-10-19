/** Validate untrusted webview bytes before writing a user-selected destination. */
export function decodeGraphExport(format: unknown, data: unknown): { extension: string; bytes: Uint8Array } {
  if (typeof data !== "string" || data.length > 32 * 1024 * 1024) { throw new Error("Invalid graph export size"); }
  if (format === "svg") {
    const normalized = data.replace(/&quot;|&#(?:34|x22);/gi, '\"').replace(/&apos;|&#(?:39|x27);/gi, "'");
    if (!/^<svg\b/.test(data) || /<(?:script|foreignObject|image|use)\b|\bon\w+\s*=|(?:href|src)\s*=|url\(\s*(?!['"]?#)|@import|<!DOCTYPE|<!ENTITY/i.test(normalized)) { throw new Error("Invalid SVG export"); }
    return { extension: "svg", bytes: Buffer.from(data, "utf8") };
  }
  if (format === "png") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) { throw new Error("Invalid PNG encoding"); }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii", 12, 16) !== "IHDR") { throw new Error("Invalid PNG export"); }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) { throw new Error("PNG export exceeds pixel limit"); }
    return { extension: "png", bytes };
  }
  throw new Error("Unsupported graph export format");
}
