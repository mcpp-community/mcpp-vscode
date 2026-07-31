export type ToolchainSource = "managed" | "system";
export type ToolchainStatus = "installed" | "available" | "planned";

export interface ToolchainItem {
  family: string;
  version: string;
  spec: string;
  source: ToolchainSource;
  effective: boolean;
}

export interface TargetItem {
  target: string;
  note: string;
  toolchainSpec: string | undefined;
  status: ToolchainStatus;
  effective: boolean;
}

export interface ToolchainInventory {
  installed: ToolchainItem[];
  available: ToolchainItem[];
  targets: TargetItem[];
  effective: ToolchainItem | undefined;
  effectiveTarget: string | undefined;
  globalDefaultSpec: string | undefined;
  projectOverridesGlobal: boolean;
  recognized: boolean;
  rawOutput: string;
}

type Section = "managed" | "system" | "available" | "targets" | undefined;

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const FAMILY_PATTERN = "[A-Za-z][A-Za-z0-9+_.-]*";
const VERSION_PATTERN = "[0-9][A-Za-z0-9+_.:-]*";
const SPEC_VERSION_PATTERN = `(?:${VERSION_PATTERN}|system)`;
const AUXILIARY_WORDS = new Set([
  "available",
  "default",
  "global",
  "host",
  "installed",
  "no",
  "none",
  "run",
  "system",
  "target",
  "targets",
  "toolchain",
  "toolchains",
]);

export function mcppCommandArguments(...args: string[]): string[] {
  return [...args];
}

export function normalizeToolchainSpec(input: string): string | undefined {
  let value = input.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      value = value.slice(1, -1).trim();
    }
  }

  if (/^msvc$/i.test(value)) {
    return "msvc";
  }

  const atMatch = value.match(
    new RegExp(`^(${FAMILY_PATTERN})@(${SPEC_VERSION_PATTERN})$`, "i"),
  );
  if (atMatch !== null) {
    const family = atMatch[1].toLowerCase();
    const version = atMatch[2];
    if (version.toLowerCase() === "system" && family !== "msvc") {
      return undefined;
    }
    return `${family}@${version}`;
  }

  const spacedMatch = value.match(
    new RegExp(`^(${FAMILY_PATTERN})\\s+(${VERSION_PATTERN})$`),
  );
  if (spacedMatch !== null) {
    return `${spacedMatch[1].toLowerCase()}@${spacedMatch[2]}`;
  }

  return undefined;
}

export function isMsvcToolchainSpec(input: string): boolean {
  const normalized = normalizeToolchainSpec(input);
  return normalized === "msvc" || normalized?.startsWith("msvc@") === true;
}

export type ToolchainInstallKind = "managed-host" | "managed-target" | "system-detect";

/**
 * 返回 mcpp 旧兼容拼写隐含的 target 轴；undefined 表示没有隐含 target。
 * 首版插件不传 --target，因此这类输入交给 mcpp CLI 处理。
 */
export type ToolchainSpecTargetHint = "musl" | "windows-gnu" | "target";

export function toolchainSpecTargetHint(input: string): ToolchainSpecTargetHint | undefined {
  const normalized = normalizeToolchainSpec(input)?.toLowerCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (
    normalized.startsWith("musl-gcc@")
    || (normalized.startsWith("gcc@") && normalized.endsWith("-musl"))
  ) {
    return "musl";
  }
  const atIndex = normalized.indexOf("@");
  const compiler = atIndex === -1 ? normalized : normalized.slice(0, atIndex);
  if (compiler.includes("mingw")) {
    return "windows-gnu";
  }
  // mcpp 还接受带 triple 的旧编译器写法，例如
  // `aarch64-linux-musl-gcc@16`。即使环境不是上面列出的 host-only 别名，
  // 这种写法仍然携带 target 轴。
  if (compiler.endsWith("-gcc")) {
    return compiler.includes("-musl-") ? "musl" : "target";
  }
  return undefined;
}

export function toolchainInstallKind(input: string): ToolchainInstallKind {
  if (isMsvcToolchainSpec(input)) {
    return "system-detect";
  }
  return toolchainSpecTargetHint(input) === undefined ? "managed-host" : "managed-target";
}

export function hostDefaultToolchains(inventory: ToolchainInventory): ToolchainItem[] {
  const hostSpecs = new Set(
    inventory.targets
      .filter((target) => target.status === "installed" && /\bhost\b/i.test(target.note))
      .map((target) => target.toolchainSpec)
      .filter((spec): spec is string => spec !== undefined),
  );
  const windowsHost = inventory.targets.some((target) =>
    target.status !== "planned"
    && target.target.endsWith("-windows-msvc")
    && /\bhost\b/i.test(target.note),
  );
  const windowsGccSpecs = new Set(
    inventory.targets
      .filter((target) => target.status === "installed" && target.target.endsWith("-windows-gnu"))
      .map((target) => target.toolchainSpec)
      .filter((spec): spec is string => spec !== undefined),
  );
  if (inventory.targets.length === 0) {
    return inventory.installed;
  }
  return inventory.installed.filter((toolchain) =>
    toolchain.source === "system"
    || hostSpecs.has(toolchain.spec)
    // mcpp 在 Windows 上将省略 target 的 GCC 映射到 MinGW payload。
    || (windowsHost && toolchain.family === "gcc" && windowsGccSpecs.has(toolchain.spec)));
}

function sectionForHeader(line: string): Section | "header" | false {
  if (/^\s*Toolchains\s*:\s*$/i.test(line)) {
    return "managed";
  }
  if (/^\s*System(?:\s+toolchains?)?\s*:\s*$/i.test(line)) {
    return "system";
  }
  if (/^\s*Targets\s*:\s*$/i.test(line)) {
    return "targets";
  }
  if (/^\s*Available\s+toolchains?\b.*:\s*$/i.test(line)) {
    return "available";
  }
  if (/^\s*[A-Za-z][A-Za-z0-9 _-]*\s*:\s*$/i.test(line)) {
    return "header";
  }
  return false;
}

function parseToolchainRow(
  line: string,
  source: ToolchainSource,
): Array<{ family: string; version: string; effective: boolean; spec: string }> | undefined {
  let value = line.trim();
  let effective = false;
  if (value.startsWith("*")) {
    effective = true;
    value = value.slice(1).trimStart();
  }
  if (value.startsWith("-")) {
    value = value.slice(1).trimStart();
  }
  if (value.startsWith("(") || value.length === 0) {
    return undefined;
  }

  const tokens = value.split(/\s+/);
  const firstToken = tokens[0];
  if (firstToken === undefined || AUXILIARY_WORDS.has(firstToken.toLowerCase())) {
    return undefined;
  }

  let family: string;
  let versions: string[];
  if (firstToken.includes("@")) {
    const spec = normalizeToolchainSpec(firstToken);
    if (spec === undefined) {
      return undefined;
    }
    const atIndex = firstToken.indexOf("@");
    family = firstToken.slice(0, atIndex).toLowerCase();
    versions = [firstToken.slice(atIndex + 1)];
  } else {
    const secondToken = tokens[1];
    if (secondToken === undefined || !new RegExp(`^${VERSION_PATTERN}$`).test(secondToken)) {
      return undefined;
    }
    family = firstToken.toLowerCase();
    versions = [secondToken];
    for (let index = 2; index + 1 < tokens.length; index += 2) {
      if (tokens[index] !== "/" || !new RegExp(`^${VERSION_PATTERN}$`).test(tokens[index + 1])) {
        break;
      }
      versions.push(tokens[index + 1]);
    }
  }

  return versions.flatMap((version) => {
    const spec = source === "system" && family === "msvc"
      ? "msvc"
      : normalizeToolchainSpec(`${family} ${version}`);
    return spec === undefined ? [] : [{ family, version, spec, effective }];
  });
}

function parseTargetRow(line: string): TargetItem | undefined {
  let value = line.trim();
  let effective = false;
  if (value.startsWith("*")) {
    effective = true;
    value = value.slice(1).trimStart();
  }
  if (value.startsWith("-")) {
    value = value.slice(1).trimStart();
  }

  const tokens = value.split(/\s+/);
  if (tokens.length < 3 || tokens[0]?.toUpperCase() === "TARGET") {
    return undefined;
  }
  const statusToken = tokens.at(-1)?.toLowerCase();
  if (statusToken !== "installed" && statusToken !== "available" && statusToken !== "planned") {
    return undefined;
  }

  const target = tokens[0];
  const columns = tokens.slice(1, -1);
  if (target === undefined || columns.length === 0) {
    return undefined;
  }

  const lastColumn = columns.at(-1);
  let noteColumns: string[];
  let toolchainSpec: string | undefined;
  if (lastColumn === "\u2014" || lastColumn === "-") {
    noteColumns = columns.slice(0, -1);
  } else if (columns.length >= 2) {
    const family = columns.at(-2);
    const version = columns.at(-1);
    if (family === undefined || version === undefined) {
      return undefined;
    }
    toolchainSpec = normalizeToolchainSpec(family + " " + version);
    if (toolchainSpec === undefined) {
      return undefined;
    }
    noteColumns = columns.slice(0, -2);
  } else {
    return undefined;
  }

  return {
    target,
    note: noteColumns.join(" "),
    toolchainSpec,
    status: statusToken,
    effective,
  };
}

interface ParsedGlobalDefault {
  value: string | undefined;
}

function parseGlobalDefault(line: string): ParsedGlobalDefault | undefined {
  const match = line.match(/\bglobal\s+default\s+is\s+['"]([^'"]+)['"]/i);
  if (match !== null) {
    return { value: normalizeToolchainSpec(match[1]) };
  }
  const none = line.match(/\bglobal\s+default\s+is\s+['"]?<none>['"]?/i);
  if (none !== null) {
    return { value: undefined };
  }
  const unquoted = line.match(
    new RegExp(`\\bglobal\\s+default\\s+is\\s+(${FAMILY_PATTERN}(?:@${SPEC_VERSION_PATTERN}|\\s+${VERSION_PATTERN}|))\\b`, "i"),
  );
  return unquoted === null ? undefined : { value: normalizeToolchainSpec(unquoted[1]) };
}

export function parseToolchainList(output: string): ToolchainInventory {
  const installed: ToolchainItem[] = [];
  const available: ToolchainItem[] = [];
  const targets: TargetItem[] = [];
  let effective: ToolchainItem | undefined;
  let effectiveTarget: string | undefined;
  let section: Section;
  let recognized = false;
  let projectMarker = false;
  let explicitGlobalDefault: string | undefined;
  let explicitGlobalDefaultSeen = false;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE, "");
    const lowerLine = line.toLowerCase();
    if (lowerLine.includes("no toolchains installed")) {
      recognized = true;
    }
    if (/effective\s+toolchain\s+from\s+project\s+mcpp\.toml\s+\[toolchain\]/i.test(line)) {
      projectMarker = true;
    }
    const parsedGlobalDefault = parseGlobalDefault(line);
    if (parsedGlobalDefault !== undefined) {
      explicitGlobalDefaultSeen = true;
      explicitGlobalDefault = parsedGlobalDefault.value;
    }

    const header = sectionForHeader(line);
    if (header !== false) {
      if (header === "header") {
        section = undefined;
      } else {
        recognized = true;
        section = header;
      }
      continue;
    }

    if (section === undefined) {
      continue;
    }
    if (section === "targets") {
      const target = parseTargetRow(line);
      if (target === undefined) {
        continue;
      }
      targets.push(target);
      if (target.effective && effectiveTarget === undefined) {
        effectiveTarget = target.target;
      }
      continue;
    }
    const parsedRows = parseToolchainRow(line, section === "system" ? "system" : "managed");
    if (parsedRows === undefined) {
      continue;
    }
    for (const parsed of parsedRows) {
      const item: ToolchainItem = {
        family: parsed.family,
        version: parsed.version,
        spec: parsed.spec,
        source: section === "system" ? "system" : "managed",
        effective: parsed.effective,
      };
      if (section === "available") {
        available.push(item);
      } else {
        installed.push(item);
        if (item.effective && effective === undefined) {
          effective = item;
        }
      }
    }
  }

  const globalDefaultSpec = recognized
    ? explicitGlobalDefaultSeen ? explicitGlobalDefault : effective?.spec
    : undefined;
  const projectOverridesGlobal = recognized
    && (projectMarker
      || (explicitGlobalDefaultSeen
        && effective !== undefined
        && explicitGlobalDefault !== effective.spec));

  return {
    installed,
    available,
    targets,
    effective,
    effectiveTarget,
    globalDefaultSpec,
    projectOverridesGlobal,
    recognized,
    rawOutput: output,
  };
}
