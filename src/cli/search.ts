// `mcpp search` 的适配层（依赖版本补全，方案默认关）。
//
// **这是全项目唯一解析「人类输出」的地方。** `mcpp search` 没有机读格式
// （`--all-versions` 也只改人类列表的详细程度，不是 JSON），所以这里只能按
// 实测行形状解析，并且必须防御性地失败：看不懂的行一律跳过，绝不抛异常、
// 绝不半猜。mcpp 一旦提供机读格式就替换本模块（方案 §3.3.2 已登记）。
//
// 纯字符串函数：不启动进程、不读盘、不依赖 vscode。执行 `mcpp`、超时、联网
// 判定与会话缓存都由调用方负责（`mcpp.toml.indexCompletion*`）。
//
// 实测形状（mcpp 2026.9.30.2）：
//   兼容索引行   `  compat:zlib           A compression library  (1.3.2)`
//   --all-versions 多版本   `  mcpplibs:aarch64-virt-rt  …  (0.2.1, 0.2.0, 0.1.1, ...)`
//   没有版本的行（如纯 xim 工具）没有尾括号，直接跳过。

export interface PackageVersion {
  version: string;
  summary?: string;
}

/** semver 近似：数字点分，可带 `-`/`+` 后缀（`2026.07.09` 这类日期版本也算）。 */
const VERSION = /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;
/** 行尾的括号组：实测版本都写在这里。 */
const TRAILING_PARENS = /\(([^()]*)\)\s*$/;
/** 有些终端会给输出上色；颜色码不属于内容。 */
const ANSI = /\u001b\[[0-9;]*m/g;

function isVersionToken(text: string): boolean {
  return VERSION.test(text);
}

/** 去掉包标识后的描述文本；没有描述时返回 undefined。 */
function summaryOf(head: string): string | undefined {
  const match = /^\S+\s+(.*)$/.exec(head.trim());
  const summary = match?.[1]?.trim() ?? "";
  return summary === "" ? undefined : summary;
}

/** 简单 semver 比较：数字段按数值比，缺段视为更小，后缀按字典序。 */
function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/);
  const right = b.split(/[.+-]/);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }
    const ln = /^\d+$/.test(l) ? Number(l) : undefined;
    const rn = /^\d+$/.test(r) ? Number(r) : undefined;
    if (ln !== undefined && rn !== undefined) {
      if (ln !== rn) {
        return ln < rn ? -1 : 1;
      }
      continue;
    }
    const order = l.localeCompare(r);
    if (order !== 0) {
      return order < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 从 `mcpp search <name> --all-versions` 的 stdout 提取候选版本，
 * 去重后按新→旧排序。空输入、只有旁白、或形状不认识时返回空数组。
 */
export function parseSearchOutput(stdout: string): PackageVersion[] {
  if (typeof stdout !== "string" || stdout === "") {
    return [];
  }
  const byVersion = new Map<string, PackageVersion>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "").trim();
    if (line === "") {
      continue;
    }
    const match = TRAILING_PARENS.exec(line);
    if (match === null) {
      continue;
    }
    const versions = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(isVersionToken);
    if (versions.length === 0) {
      continue;
    }
    const summary = summaryOf(line.slice(0, match.index));
    for (const version of versions) {
      if (byVersion.has(version)) {
        continue;
      }
      const entry: PackageVersion = { version };
      if (summary !== undefined) {
        entry.summary = summary;
      }
      byVersion.set(version, entry);
    }
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** `mcpp` 的 argv（不含可执行文件名）。 */
export function searchArguments(name: string): string[] {
  return ["search", name, "--all-versions"];
}

/**
 * 是否执行索引查询：显式开启、工作区受信任、且未离线。
 * `name` 留给将来的 deny-list；当前判定只是三个开关的合取。
 */
export function shouldSearch(
  name: string,
  options: { enabled: boolean; offline: boolean; trusted: boolean },
): boolean {
  return options.enabled && options.trusted && !options.offline;
}
