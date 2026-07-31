export type ToolchainSource = "managed" | "system";

export interface ToolchainItem {
  family: string;
  version: string;
  spec: string;
  source: ToolchainSource;
  effective: boolean;
}

export interface ToolchainInventory {
  installed: ToolchainItem[];
  available: ToolchainItem[];
  effective: ToolchainItem | undefined;
  globalDefaultSpec: string | undefined;
  projectOverridesGlobal: boolean;
  recognized: boolean;
  rawOutput: string;
}

type Section = "managed" | "system" | "available" | undefined;

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const FAMILY_PATTERN = "[A-Za-z][A-Za-z0-9+_.-]*";
const VERSION_PATTERN = "[0-9][A-Za-z0-9+_.-]*";
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
    new RegExp(`^(${FAMILY_PATTERN})@(${VERSION_PATTERN})$`),
  );
  if (atMatch !== null) {
    if (atMatch[1].toLowerCase() === "msvc") {
      return "msvc";
    }
    return `${atMatch[1].toLowerCase()}@${atMatch[2]}`;
  }

  const spacedMatch = value.match(
    new RegExp(`^(${FAMILY_PATTERN})\\s+(${VERSION_PATTERN})$`),
  );
  if (spacedMatch !== null) {
    if (spacedMatch[1].toLowerCase() === "msvc") {
      return "msvc";
    }
    return `${spacedMatch[1].toLowerCase()}@${spacedMatch[2]}`;
  }

  return undefined;
}

function sectionForHeader(line: string): Section | "header" | false {
  if (/^\s*Toolchains\s*:\s*$/i.test(line)) {
    return "managed";
  }
  if (/^\s*System(?:\s+toolchains?)?\s*:\s*$/i.test(line)) {
    return "system";
  }
  if (/^\s*Available\s+toolchains?\s*:\s*$/i.test(line)) {
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
): { family: string; version: string; effective: boolean; spec: string } | undefined {
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
  let version: string;
  let spec: string | undefined;
  if (firstToken.includes("@")) {
    spec = normalizeToolchainSpec(firstToken);
    if (spec === undefined) {
      return undefined;
    }
    const atIndex = firstToken.indexOf("@");
    family = firstToken.slice(0, atIndex).toLowerCase();
    version = firstToken.slice(atIndex + 1);
  } else {
    const secondToken = tokens[1];
    if (secondToken === undefined || !new RegExp(`^${VERSION_PATTERN}$`).test(secondToken)) {
      return undefined;
    }
    family = firstToken.toLowerCase();
    version = secondToken;
    spec = normalizeToolchainSpec(`${family} ${version}`);
  }
  if (spec === undefined) {
    return undefined;
  }

  if (source === "system" && family === "msvc") {
    spec = "msvc";
  }
  return { family, version, spec, effective };
}

function parseGlobalDefault(line: string): string | undefined {
  const match = line.match(/\bglobal\s+default\s+is\s+['"]([^'"]+)['"]/i);
  if (match !== null) {
    return normalizeToolchainSpec(match[1]);
  }
  const unquoted = line.match(
    new RegExp(`\\bglobal\\s+default\\s+is\\s+(${FAMILY_PATTERN}(?:@${VERSION_PATTERN}|\\s+${VERSION_PATTERN}|))\\b`, "i"),
  );
  return unquoted === null ? undefined : normalizeToolchainSpec(unquoted[1]);
}

export function parseToolchainList(output: string): ToolchainInventory {
  const installed: ToolchainItem[] = [];
  const available: ToolchainItem[] = [];
  let effective: ToolchainItem | undefined;
  let section: Section;
  let recognized = false;
  let projectMarker = false;
  let explicitGlobalDefault: string | undefined;

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
      explicitGlobalDefault = parsedGlobalDefault;
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
    const parsed = parseToolchainRow(line, section === "system" ? "system" : "managed");
    if (parsed === undefined) {
      continue;
    }
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

  const globalDefaultSpec = recognized
    ? explicitGlobalDefault ?? effective?.spec
    : undefined;
  const projectOverridesGlobal = recognized
    && (projectMarker
      || (explicitGlobalDefault !== undefined
        && effective !== undefined
        && explicitGlobalDefault !== effective.spec));

  return {
    installed,
    available,
    effective,
    globalDefaultSpec,
    projectOverridesGlobal,
    recognized,
    rawOutput: output,
  };
}
