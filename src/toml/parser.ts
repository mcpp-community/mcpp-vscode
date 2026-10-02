// mcpp.toml 的容错解析层：为代码补全提供结构化信息。
// 设计目标是容错而非校验——用户在编辑器里输入到一半（未闭合的 `[`、字符串、
// 内联表）时不抛异常，而是把已识别的结构连同精确的 0 基行列范围返回。
// 本模块不依赖 vscode API，可在 node --test 下直接测试；extension.ts 负责
// 把这里的纯数据上下文映射为 CompletionItem。
//
// 覆盖的 TOML 子集：段头（含 [[...]] 数组表、单/双引号段）、裸键/引号键/
// 点分键、字符串（含三引号多行串）、整数、布尔、数组与内联表（可嵌套、
// 可跨行）、行注释。CRLF 行尾在进入解析前剥除，列号按剥除后的文本计算。

/** 0 基行列范围，end 为开区间（与 VS Code Range 同构）。 */
export interface TomlRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** 键/段路径中的一段：已去引号的名字 + 原始 token 的范围（含引号）。 */
export interface TomlKeySegment {
  name: string;
  quoted: boolean;
  range: TomlRange;
}

export type TomlValueKind = "string" | "integer" | "boolean" | "array" | "inlineTable" | "unknown";

/** 值节点。open = true 表示结构未闭合（输入到一半），range 延伸到文档末尾。 */
export interface TomlValueNode {
  kind: TomlValueKind;
  range: TomlRange;
  /** 未闭合（字符串缺右引号、数组缺 ]、内联表缺 }）。 */
  open: boolean;
  /** 标量原文：字符串为去引号内容（未做转义还原），整数/布尔为原文 token。 */
  text?: string;
  /** 字符串节点：引号字符。 */
  quote?: '"' | "'";
  /** 字符串节点：是否三引号多行串。 */
  multiline?: boolean;
  /** 字符串节点：内容范围（不含引号；未闭合时延伸到扫描终点）。 */
  contentRange?: TomlRange;
  /** 数组节点：已解析出的元素。 */
  elements?: TomlValueNode[];
  /** 内联表节点：已解析出的键值条目。 */
  entries?: TomlKeyValueNode[];
}

/** 键值对节点：keyPath 为点分键拆出的段数组（如 capi.lua → [capi, lua]）。 */
export interface TomlKeyValueNode {
  type: "keyValue";
  keyPath: TomlKeySegment[];
  range: TomlRange;
  /** 缺省表示 `=` 之后没有可用值（含尚未输入的情况）。 */
  value?: TomlValueNode;
}

/** 段头节点。open = true 表示 `]` 尚未输入。 */
export interface TomlSectionNode {
  type: "section";
  /** 段路径段（已去引号，如 [target.'cfg(windows)'.build] → target / cfg(windows) / build）。 */
  segments: TomlKeySegment[];
  /** 是否为 [[...]] 数组表段头。 */
  isArray: boolean;
  open: boolean;
  range: TomlRange;
  /** 段头所在行（0 基）。 */
  line: number;
}

export type TomlNode = TomlSectionNode | TomlKeyValueNode;

export interface TomlDocument {
  nodes: TomlNode[];
}

/** 段归属语义：top = 文档顶部尚无段头；unknown = 未识别的自定义段；known = 已知段组。 */
export type SectionResolution =
  | { kind: "top" }
  | { kind: "unknown"; segments: string[] }
  | { kind: "known"; group: string };

/** 当前 token 的替换范围（与光标同行的起止列），供补全做显式 range。 */
export interface ReplaceRange {
  startCharacter: number;
  endCharacter: number;
}

/** 光标的结构化上下文（纯数据）。 */
export type TomlCursorContext =
  | {
      kind: "section-header";
      /** 光标所在 token 之前已解析出的段路径段（去引号）。 */
      segments: string[];
      isArray: boolean;
      replaceRange: ReplaceRange;
    }
  | {
      kind: "key";
      section: SectionResolution;
      /** 容器路径：顶层语句为 []；内联表内为从语句根键开始的路径（如 simd = { flags = [ { … 深处为 ["simd","flags"]）。 */
      containerPath: string[];
      /** 同一行点分键中光标 token 之前已输入的段（如 capi.la| → ["capi"]）。 */
      keyPrefix: string[];
      replaceRange: ReplaceRange;
    }
  | {
      kind: "value";
      section: SectionResolution;
      /** 所属键的完整路径（含内联表/数组下钻）。 */
      keyPath: string[];
      /** 光标处值的种类；值尚未开始或不可判定时为 undefined。 */
      valueKind: TomlValueKind | undefined;
      insideString: boolean;
      /** 所在字符串未闭合（不在字符串内时为 false）。 */
      stringOpen: boolean;
      replaceRange: ReplaceRange;
    };

/** 精确匹配的已知段（与 mcpp manifest 层一致）。 */
const KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  "package",
  "lib",
  "build",
  "generated_files",
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "features",
  "indices",
  "capabilities",
  "runtime",
  "resources",
  "toolchain",
  "xlings",
  "xlings.workspace",
  "xlings.envs",
  "workspace",
  "workspace.dependencies",
  "pack",
  "pack.bundle-project",
  "language",
  "tools.overrides",
]);

/** 参数化段基组：<base>.<name> 归入 <base>（dependencies 系支持命名空间再嵌套）。 */
const PARAMETERIZED_BASES: ReadonlySet<string> = new Set([
  "targets",
  "profile",
  "feature-deps",
  "dependencies",
  "dev-dependencies",
]);

function resolveGroup(segments: readonly string[]): string | undefined {
  const joined = segments.join(".");
  if (KNOWN_SECTIONS.has(joined)) {
    return joined;
  }
  const head = segments[0];
  if (head === "target") {
    // [target.<sel>] 或 [target.<sel>.<子表>]；sel 是三元组或去引号后的
    // cfg 表达式，本身不含未引号点，因此子表部分从第三段开始。
    if (segments.length <= 2) {
      return "target";
    }
    return resolveGroup(segments.slice(2));
  }
  if (head === "runtime" && segments.length === 2) {
    // [runtime."<capability>"]：带点 capability 名的显式 provider 子表。
    return "runtime.capability";
  }
  if (PARAMETERIZED_BASES.has(head) && segments.length >= 2) {
    return head;
  }
  if (head === "workspace" && segments[1] === "dependencies" && segments.length >= 3) {
    return "workspace.dependencies";
  }
  return undefined;
}

/**
 * 把解析出的段路径规范化为语义组。空 segments 表示文档顶部（尚无段头），
 * 未识别的段返回 unknown，由调用方区分这两种情况。
 */
export function resolveSection(segments: readonly string[]): SectionResolution {
  if (segments.length === 0) {
    return { kind: "top" };
  }
  const group = resolveGroup(segments);
  return group === undefined
    ? { kind: "unknown", segments: [...segments] }
    : { kind: "known", group };
}

interface Pos {
  line: number;
  col: number;
}

/** 内部控制流信号：光标上下文已捕获，提前结束扫描。解析本身永不抛异常。 */
const CONTEXT_FOUND = Symbol("mcppTomlContextFound");

function isBareKeyChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "-"
  );
}

/** 逐行容错扫描器。行列均为 0 基，列按剥除 \r 后的文本计算。 */
class Scanner {
  private readonly lines: string[];
  private line = 0;
  private col = 0;
  private readonly cursor: Pos | undefined;
  /** 光标上下文捕获结果。 */
  context: TomlCursorContext | undefined;
  /** 扫描过程中最近经过的段头，用于给键/值上下文标注段归属。 */
  private currentSection: TomlSectionNode | undefined;

  constructor(lines: readonly string[], cursor?: Pos) {
    this.lines = lines
      .map((text) => (text.endsWith("\r") ? text.slice(0, -1) : text));
    if (this.lines.length === 0) {
      this.lines.push("");
    }
    if (cursor !== undefined) {
      // 越界坐标钳制到文档内，保证补全在任意光标位置都能得到上下文。
      const line = Math.min(Math.max(0, cursor.line), this.lines.length - 1);
      const col = Math.min(Math.max(0, cursor.col), this.lines[line].length);
      this.cursor = { line, col };
    }
  }

  // ---- 基础游标操作 ----

  private pos(): Pos {
    return { line: this.line, col: this.col };
  }

  private eof(): boolean {
    return this.line >= this.lines.length;
  }

  private atEol(): boolean {
    return this.eof() || this.col >= this.lines[this.line].length;
  }

  private peek(): string {
    return this.atEol() ? "" : this.lines[this.line][this.col];
  }

  private peekAt(offset: number): string {
    if (this.eof()) {
      return "";
    }
    const text = this.lines[this.line];
    return this.col + offset < text.length ? text[this.col + offset] : "";
  }

  private advance(): void {
    if (this.eof()) {
      return;
    }
    this.col += 1;
    if (this.col > this.lines[this.line].length) {
      this.line += 1;
      this.col = 0;
    }
  }

  private samePos(a: Pos, b: Pos): boolean {
    return a.line === b.line && a.col === b.col;
  }

  private cmpPos(a: Pos, b: Pos): number {
    return a.line - b.line || a.col - b.col;
  }

  private skipInlineWs(): void {
    while (this.peek() === " " || this.peek() === "\t") {
      this.col += 1;
    }
  }

  /** 跳过空白、换行与行注释（# 到行尾；字符串内的 # 不会走到这里）。 */
  private skipTrivia(): void {
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t") {
        this.col += 1;
        continue;
      }
      if (this.atEol()) {
        this.line += 1;
        this.col = 0;
        continue;
      }
      if (ch === "#") {
        while (!this.atEol()) {
          this.col += 1;
        }
        continue;
      }
      break;
    }
  }

  private rangeFrom(start: Pos): TomlRange {
    return {
      startLine: start.line,
      startCharacter: start.col,
      endLine: this.line,
      endCharacter: this.col,
    };
  }

  private sliceText(a: Pos, b: Pos): string {
    if (a.line === b.line) {
      return this.lines[a.line].slice(a.col, b.col);
    }
    const parts = [this.lines[a.line].slice(a.col)];
    for (let l = a.line + 1; l < b.line; l += 1) {
      parts.push(this.lines[l]);
    }
    parts.push(this.lines[b.line].slice(0, b.col));
    return parts.join("\n");
  }

  // ---- 光标上下文捕获 ----

  private cursorReached(): boolean {
    const cursor = this.cursor;
    return cursor !== undefined && this.cmpPos(this.pos(), cursor) >= 0;
  }

  /** 光标是否落在范围内（端点含尾：补全时光标常贴在 token 末尾）。 */
  private cursorWithin(range: TomlRange): boolean {
    const cursor = this.cursor;
    if (cursor === undefined) {
      return false;
    }
    if (cursor.line < range.startLine || cursor.line > range.endLine) {
      return false;
    }
    if (cursor.line === range.startLine && cursor.col < range.startCharacter) {
      return false;
    }
    if (cursor.line === range.endLine && cursor.col > range.endCharacter) {
      return false;
    }
    return true;
  }

  /** 在光标行上向左/右扩展 token（遇 stop 字符停），用于字符串内容等无预扫描范围的替换区间。 */
  private expandOnLine(stop: (ch: string) => boolean): ReplaceRange {
    const cursor = this.cursor;
    if (cursor === undefined) {
      return { startCharacter: 0, endCharacter: 0 };
    }
    const text = this.lines[cursor.line] ?? "";
    const at = Math.min(cursor.col, text.length);
    let start = at;
    let end = at;
    while (start > 0 && !stop(text[start - 1])) {
      start -= 1;
    }
    while (end < text.length && !stop(text[end])) {
      end += 1;
    }
    return { startCharacter: start, endCharacter: end };
  }

  private emptyReplaceRange(): ReplaceRange {
    const cursor = this.cursor;
    const col = cursor?.col ?? 0;
    return { startCharacter: col, endCharacter: col };
  }

  private static tokenReplaceRange(range: TomlRange): ReplaceRange {
    // 键/段 token 保证单行（引号键跨行即视为未闭合而截断在行尾）。
    return { startCharacter: range.startCharacter, endCharacter: range.endCharacter };
  }

  /** 单行范围转替换范围；跨行值（数组/多行串）返回 undefined，由调用方回退。 */
  private static singleLineReplaceRange(range: TomlRange): ReplaceRange | undefined {
    if (range.startLine !== range.endLine) {
      return undefined;
    }
    return { startCharacter: range.startCharacter, endCharacter: range.endCharacter };
  }

  private sectionResolution(): SectionResolution {
    if (this.currentSection === undefined) {
      return { kind: "top" };
    }
    return resolveSection(this.currentSection.segments.map((segment) => segment.name));
  }

  private capture(context: TomlCursorContext): never {
    this.context = context;
    throw CONTEXT_FOUND;
  }

  private captureKey(containerPath: readonly string[], keyPrefix: readonly string[], token?: TomlRange): never {
    this.capture({
      kind: "key",
      section: this.sectionResolution(),
      containerPath: [...containerPath],
      keyPrefix: [...keyPrefix],
      replaceRange: token !== undefined ? Scanner.tokenReplaceRange(token) : this.emptyReplaceRange(),
    });
  }

  private captureValue(
    keyPath: readonly string[],
    valueKind: TomlValueKind | undefined,
    options?: { insideString?: boolean; stringOpen?: boolean; replaceRange?: ReplaceRange },
  ): never {
    this.capture({
      kind: "value",
      section: this.sectionResolution(),
      keyPath: [...keyPath],
      valueKind,
      insideString: options?.insideString ?? false,
      stringOpen: options?.stringOpen ?? false,
      replaceRange: options?.replaceRange ?? this.emptyReplaceRange(),
    });
  }

  private captureHeader(segments: readonly TomlKeySegment[], isArray: boolean, token?: TomlRange): never {
    this.capture({
      kind: "section-header",
      segments: segments.map((segment) => segment.name),
      isArray,
      replaceRange: token !== undefined ? Scanner.tokenReplaceRange(token) : this.emptyReplaceRange(),
    });
  }

  /** 扫描到文档末尾仍未捕获光标上下文时的兜底：当前段内的顶层键位置。 */
  finalContext(): TomlCursorContext {
    return {
      kind: "key",
      section: this.sectionResolution(),
      containerPath: [],
      keyPrefix: [],
      replaceRange: this.emptyReplaceRange(),
    };
  }

  // ---- 结构扫描 ----

  scan(): TomlNode[] {
    const nodes: TomlNode[] = [];
    while (!this.eof()) {
      this.skipTrivia();
      // 光标落在语句之间的空白/注释里：视为顶层键位置（新语句的起点）。
      if (this.cursorReached()) {
        this.captureKey([], []);
      }
      if (this.eof()) {
        break;
      }
      const start = this.pos();
      if (this.peek() === "[") {
        nodes.push(this.scanHeader(start));
      } else {
        const keyValue = this.scanKeyValue([]);
        if (keyValue !== undefined) {
          nodes.push(keyValue);
        }
      }
      // 进度保护：任何无法识别的垃圾字符都必须被消费，保证容错扫描必然终止。
      if (this.samePos(this.pos(), start)) {
        this.advance();
      }
    }
    return nodes;
  }

  /** 段头：[a.b] / [[a.b]] / 引号段；未闭合（缺 ]）时 open = true 并跳过该行剩余内容。 */
  private scanHeader(start: Pos): TomlSectionNode {
    this.advance(); // [
    let isArray = false;
    if (this.peek() === "[") {
      isArray = true;
      this.advance();
    }
    const segments: TomlKeySegment[] = [];
    let open = true;
    for (;;) {
      this.skipInlineWs();
      // 光标在段之间的空白/点号附近（如 `[targets.` 之后）。
      if (this.cursorReached()) {
        this.captureHeader(segments, isArray);
      }
      const segment = this.scanKeySegment();
      if (segment === undefined) {
        break;
      }
      if (this.cursorWithin(segment.range)) {
        this.captureHeader(segments, isArray, segment.range);
      }
      segments.push(segment);
      this.skipInlineWs();
      if (this.peek() === ".") {
        this.advance();
        continue;
      }
      break;
    }
    this.skipInlineWs();
    if (this.cursorReached()) {
      this.captureHeader(segments, isArray);
    }
    if (this.peek() === "]") {
      this.advance();
      if (isArray && this.peek() === "]") {
        this.advance();
      }
      // 容错：[[x] 只写了一个 ] 也视为已闭合。
      open = false;
    }
    if (open) {
      // 未闭合段头：跳过该行剩余内容，避免残余字符被当作下一条语句。
      while (!this.atEol()) {
        this.col += 1;
      }
    }
    const node: TomlSectionNode = {
      type: "section",
      segments,
      isArray,
      open,
      range: this.rangeFrom(start),
      line: start.line,
    };
    this.currentSection = node;
    return node;
  }

  /** 单个键/段路径段：裸键或单/双引号键（引号键跨行即按未闭合截断）。 */
  private scanKeySegment(): TomlKeySegment | undefined {
    const start = this.pos();
    const quote = this.peek();
    if (quote === '"' || quote === "'") {
      this.advance();
      const contentStart = this.pos();
      while (!this.atEol() && this.peek() !== quote) {
        // 双引号键内的转义（如 \"）不结束键。
        if (quote === '"' && this.peek() === "\\" && this.col + 1 < this.lines[this.line].length) {
          this.col += 2;
          continue;
        }
        this.col += 1;
      }
      const contentEnd = this.pos();
      if (this.peek() === quote) {
        this.advance();
      }
      return {
        name: this.sliceText(contentStart, contentEnd),
        quoted: true,
        range: this.rangeFrom(start),
      };
    }
    if (!isBareKeyChar(quote)) {
      return undefined;
    }
    while (isBareKeyChar(this.peek())) {
      this.col += 1;
    }
    return {
      name: this.sliceText(start, this.pos()),
      quoted: false,
      range: this.rangeFrom(start),
    };
  }

  /**
   * 键值对：点分键 [= 值]。containerPath 是内联表递归时下钻的键路径
   * （顶层语句为 []）。无法识别出键也没有值时返回 undefined。
   */
  private scanKeyValue(containerPath: readonly string[]): TomlKeyValueNode | undefined {
    const start = this.pos();
    const segments: TomlKeySegment[] = [];
    for (;;) {
      this.skipInlineWs();
      // 光标在键槽位的空白处（如 `{ ` 之后、键未开始时）。
      if (this.cursorReached()) {
        this.captureKey(containerPath, segments.map((segment) => segment.name));
      }
      const segment = this.scanKeySegment();
      if (segment === undefined) {
        break;
      }
      if (this.cursorWithin(segment.range)) {
        this.captureKey(containerPath, segments.map((segment) => segment.name), segment.range);
      }
      segments.push(segment);
      this.skipInlineWs();
      if (this.peek() === ".") {
        this.advance();
        continue;
      }
      break;
    }
    this.skipInlineWs();
    // 光标在键与 = 之间（如 `name |`）：仍算键位置。
    if (this.cursorReached()) {
      this.captureKey(containerPath, segments.map((segment) => segment.name));
    }
    const keyNames = segments.map((segment) => segment.name);
    let value: TomlValueNode | undefined;
    if (this.peek() === "=") {
      this.advance();
      this.skipInlineWs();
      const valuePath = containerPath.concat(keyNames);
      // 光标在 = 之后、值未开始（如 `kind = |`）。
      if (this.cursorReached()) {
        // 光标后方同行还有值 token（光标恰在 token 首字符、或在 = 与 token
        // 之间的空白上）时，替换范围要覆盖整个 token，否则补全插入后原文残留。
        if (!this.atEol() && this.peek() !== "#") {
          const ahead = this.scanValue(valuePath); // 光标落在 token 内时由 scanValue 捕获
          this.captureValue(valuePath, ahead.kind, {
            replaceRange: Scanner.singleLineReplaceRange(ahead.range) ?? this.emptyReplaceRange(),
          });
        }
        this.captureValue(valuePath, undefined);
      }
      // 值必须在同行开始（TOML 本就如此）；行尾没有值则按缺失处理。
      if (!this.atEol() && this.peek() !== "#") {
        value = this.scanValue(valuePath);
      }
    }
    if (segments.length === 0 && value === undefined) {
      return undefined;
    }
    return { type: "keyValue", keyPath: segments, range: this.rangeFrom(start), value };
  }

  private scanValue(keyPath: readonly string[]): TomlValueNode {
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      return this.scanStringValue(keyPath);
    }
    if (ch === "[") {
      return this.scanArrayValue(keyPath);
    }
    if (ch === "{") {
      return this.scanInlineTableValue(keyPath);
    }
    return this.scanBareValue(keyPath);
  }

  /** 字符串：单/双引号单行串与三引号多行串；未闭合时 open = true。 */
  private scanStringValue(keyPath: readonly string[]): TomlValueNode {
    const start = this.pos();
    const quote = this.peek() as '"' | "'";
    this.advance();
    let multiline = false;
    let open = true;
    let contentStart = this.pos();
    let contentEnd = this.pos();
    if (this.peek() === quote) {
      this.advance();
      if (this.peek() === quote) {
        // 三引号多行串。
        multiline = true;
        this.advance();
        contentStart = this.pos();
      } else {
        // 空字符串 "" / ''。
        open = false;
      }
    }
    let closeStart: Pos | undefined;
    if (open) {
      while (!this.eof()) {
        if (!multiline && this.atEol()) {
          break; // 单行串跨行 → 未闭合
        }
        const ch = this.peek();
        if (ch === "\\" && quote === '"') {
          // 双引号串内的转义：跳过下一个字符（\" 不结束串）。
          this.advance();
          if (!this.eof() && (multiline || !this.atEol())) {
            this.advance();
          }
          continue;
        }
        if (ch === quote) {
          if (multiline) {
            if (this.peekAt(1) === quote && this.peekAt(2) === quote) {
              contentEnd = this.pos();
              closeStart = this.pos();
              this.advance();
              this.advance();
              this.advance();
              open = false;
              break;
            }
            this.advance();
            continue;
          }
          contentEnd = this.pos();
          closeStart = this.pos();
          this.advance();
          open = false;
          break;
        }
        this.advance();
      }
      if (open) {
        contentEnd = this.pos();
      }
    }
    const node: TomlValueNode = {
      kind: "string",
      range: this.rangeFrom(start),
      open,
      text: this.sliceText(contentStart, contentEnd),
      quote,
      multiline,
      contentRange: {
        startLine: contentStart.line,
        startCharacter: contentStart.col,
        endLine: contentEnd.line,
        endCharacter: contentEnd.col,
      },
    };
    if (this.cursorWithin(node.range)) {
      const cursor = this.cursor;
      if (cursor !== undefined) {
        const afterOpen = this.cmpPos(cursor, contentStart) >= 0;
        const beforeClose = closeStart === undefined || this.cmpPos(cursor, closeStart) <= 0;
        const insideString = afterOpen && beforeClose;
        // 字符串内容的替换范围：扩展到本行引号边界，并钳制在内容范围内。
        let replaceRange = this.emptyReplaceRange();
        if (insideString) {
          const expanded = this.expandOnLine((ch) => ch === quote);
          const minCol = contentStart.line === cursor.line ? contentStart.col : 0;
          const maxCol =
            contentEnd.line === cursor.line ? contentEnd.col : this.lines[cursor.line]?.length ?? 0;
          replaceRange = {
            startCharacter: Math.max(expanded.startCharacter, minCol),
            endCharacter: Math.min(Math.max(expanded.endCharacter, minCol), maxCol),
          };
        }
        this.captureValue(keyPath, "string", {
          insideString,
          stringOpen: open && afterOpen,
          replaceRange,
        });
      }
    }
    return node;
  }

  /** 数组：可跨行，元素递归解析；缺 ] 时 open = true。 */
  private scanArrayValue(keyPath: readonly string[]): TomlValueNode {
    const start = this.pos();
    this.advance(); // [
    const elements: TomlValueNode[] = [];
    let open = true;
    for (;;) {
      this.skipTrivia();
      // 光标在元素槽位（如 `sources = [ ` 之后）。
      if (this.cursorReached()) {
        this.captureValue(keyPath, undefined);
      }
      if (this.eof()) {
        break;
      }
      const ch = this.peek();
      if (ch === "]") {
        this.advance();
        open = false;
        break;
      }
      if (ch === ",") {
        this.advance();
        continue;
      }
      const elementStart = this.pos();
      elements.push(this.scanValue(keyPath));
      if (this.samePos(this.pos(), elementStart)) {
        this.advance(); // 进度保护
      }
    }
    return { kind: "array", range: this.rangeFrom(start), open, elements };
  }

  /** 内联表：可嵌套、可跨行，条目是完整键值对；缺 } 时 open = true。 */
  private scanInlineTableValue(keyPath: readonly string[]): TomlValueNode {
    const start = this.pos();
    this.advance(); // {
    const entries: TomlKeyValueNode[] = [];
    let open = true;
    for (;;) {
      this.skipTrivia();
      // 光标在条目键槽位（如 `simd = { flags = [ { ` 深处）。
      if (this.cursorReached()) {
        this.captureKey(keyPath, []);
      }
      if (this.eof()) {
        break;
      }
      const ch = this.peek();
      if (ch === "}") {
        this.advance();
        open = false;
        break;
      }
      if (ch === ",") {
        this.advance();
        continue;
      }
      const entryStart = this.pos();
      const entry = this.scanKeyValue(keyPath);
      if (entry !== undefined) {
        entries.push(entry);
      }
      if (this.samePos(this.pos(), entryStart)) {
        this.advance(); // 进度保护
      }
    }
    return { kind: "inlineTable", range: this.rangeFrom(start), open, entries };
  }

  /** 裸值 token：布尔、整数，其余归为 unknown（容错，不校验合法性）。 */
  private scanBareValue(keyPath: readonly string[]): TomlValueNode {
    const start = this.pos();
    let end = this.pos();
    while (!this.atEol()) {
      const ch = this.peek();
      if (ch === "," || ch === "]" || ch === "}" || ch === "[" || ch === "{" || ch === "#") {
        break;
      }
      this.col += 1;
      if (ch !== " " && ch !== "\t") {
        end = this.pos();
      }
    }
    const text = this.sliceText(start, end);
    let kind: TomlValueKind = "unknown";
    if (text === "true" || text === "false") {
      kind = "boolean";
    } else if (/^[+-]?\d[\d_]*$/.test(text)) {
      kind = "integer";
    }
    const range: TomlRange = {
      startLine: start.line,
      startCharacter: start.col,
      endLine: end.line,
      endCharacter: end.col,
    };
    if (this.cursorWithin(range)) {
      this.captureValue(keyPath, kind, { replaceRange: Scanner.tokenReplaceRange(range) });
    }
    return { kind, range, open: false, text };
  }
}

/** 容错解析整个文档，产出带 0 基行列范围的节点树。永不抛异常。 */
export function parseMcppToml(lines: readonly string[]): TomlDocument {
  const scanner = new Scanner(lines);
  return { nodes: scanner.scan() };
}

/**
 * 计算光标的结构化上下文。line / character 均为 0 基（character 按剥除
 * \r 后的文本计算）；越界坐标会被钳制到文档内。永不抛异常。
 */
export function contextAt(lines: readonly string[], line: number, character: number): TomlCursorContext {
  const scanner = new Scanner(lines, { line, col: character });
  try {
    scanner.scan();
  } catch (error) {
    if (error === CONTEXT_FOUND && scanner.context !== undefined) {
      return scanner.context;
    }
    throw error;
  }
  // 扫描结束仍未命中：光标在文档末尾的空白处，视为当前段内的顶层键位置。
  return scanner.finalContext();
}
