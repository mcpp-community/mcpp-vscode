# 与 mcpp CLI 的集成契约

> 对象：`mcpp-community/mcpp`（C++23 模块优先构建工具，下称 mcpp）。本文记录本扩展**实际
> 调用**的 mcpp 接口，以及 mcpp 已经提供、本扩展尚未使用的稳定接口。

## 1. 本扩展实际调用的命令

| 调用点 | 命令 | 依赖的输出 |
| --- | --- | --- |
| `cliController.newProject` | `mcpp new <name>` | 退出码 |
| `tasks.projectTaskPlan` | `mcpp build` / `run` / `test` / `clean` | 退出码（VS Code Task） |
| `cliController.readToolchainInventory` | `mcpp toolchain list` | **人类文本**（正则解析） |
| `cliController.selectDefaultToolchainFromInventory` | `mcpp toolchain default <spec>` | 退出码 |
| `cliController.pickInstallSpec` → `installToolchain` | `mcpp toolchain install <spec>` | 退出码 |

`mcpp.path` 为空时用 `"mcpp"`，由 VS Code 进程的 `PATH` 解析。

## 2. mcpp 已提供的稳定机读接口（本扩展未使用）

mcpp 有正式的机读输出协议（`docs/50-machine-output.md`）。**检测规则**：解析 stdout，
要求 `schemaVersion` 与 `kind` 存在；**不要**用退出码或"命令没报错"来判断支持与否。

| 命令 | `kind` | 用途 |
| --- | --- | --- |
| `mcpp --protocol-version` | `mcpp.protocol` | 静态探测：信封版本、各 kind 版本、每个命令的 `effects`；无副作用 |
| `mcpp self env --format json` | `mcpp.env` | `mcppHome` / `registry` / `xlingsBinary` / `config` / `buildCache` / `mcppVersion` / `defaultToolchain`；**只读**，不会创建 `$MCPP_HOME` |
| `mcpp toolchain list --format json` | `mcpp.toolchain.list` | `{host, toolchains[], targets[]}`，字段 `family`/`version`/`default`/`source`，target 行含 `target`/`note`/`toolchain`/`pin`/`status`/`default` |
| `mcpp emit build-database [--spec s1\|compile-commands] --format json` | `mcpp.build-database` | 构建计划；**不写工程目录**（`--configure-only` 会写 `compile_commands.json`） |
| `mcpp why toolchain --format json` | `mcpp.why.toolchain` | 某个 (target, toolchain) 的解析依据，含 `reason` token |

信封形态：

```jsonc
{ "schemaVersion": 1, "kind": "...", "kindVersion": 1,
  "effects": [], "mcpp": { "version": "2026.9.30.2",
                           "protocol": { "min": 1, "max": 1 } },
  "data": {}, "diagnostics": [] }
```

`kind` 内字段只增不删、含义不变；破坏性变更提升 `kindVersion`。

## 3. 流与退出码

- **stdout = 结果，stderr = 叙述**（2026.9.30.2 起；此前叙述在 stdout）。`mcpp toolchain list`
  这样的"列表"命令，列表本身在 stdout。
- `--format json`（带信封）与 `--json`（裸文档，如 `mcpp cache list --json`）是两种**永久并存**
  的输出；`ndjson` 不被 `--format` 接受。
- `mcpp build --configure-only` 在规划失败（无 `mcpp.toml`、工具链/依赖解析失败）时返回 **2**，
  而不是 1；`mcpp emit build-database` 对同类失败返回 **1** 并给出信封与 `diagnostics`。
- 完整退出码契约（SPEC-003）：`0` 成功、`1` 运行期失败、`2` 用法错误、**`4` 环境未就绪**、
  `70` 内部错误、`101` **仅 `mcpp run`** 的构建失败、`127` 未知命令。
- **退出码不得用于协议识别**：判断某功能是否支持，唯一跨版本成立的判据是解析 stdout。
- `1` 可以与 stdout 上的信封同时出现，不要因为非零退出就丢弃已解析到的文档。
- `mcpp run` 透传被运行程序的退出码（`0–124`）；`125/126/127` 是 spawn 被拒。

## 4. 明确不是接口的东西

`docs/51-supported-versions.md` 的表面稳定性表把 `mcpp.toml` 键、CLI 命令与标志、机读输出、
`build.mcpp` 指令协议、`mcpp.lock`、target 行列为 additive；而 **构建指纹、缓存布局与
`target/` 下的内容不是接口**，无通知即变。判断"要不要重新规划"请用
`mcpp emit build-database` 的 `watch` 与 `inputs-fingerprint`。

## 5. mcpp 版本

形如 `2026.10.1.3`（`年.月.日.序号`），数字**不携带**兼容性承诺。`mcpp --version` 输出
`mcpp <version>`（**无** `v` 前缀）；`mcpp --help` 的横幅反而带 `v`，不要从那里抓版本。
机读版本号在 `mcpp self env --format json` 的 `data.mcppVersion`，以及任何信封的
`mcpp.version`。mcpp 自身仍标注为早期项目，接口与行为可能变化；`docs/50` 与 `docs/specs/`
是兼容性承诺的来源。

## 6. 本扩展对 mcpp 的已知假设（需要随 mcpp 版本复核）

1. `mcpp toolchain list` 的人类输出包含 `Toolchains:` / `Targets:` / `Available toolchains...:` 段，
   用 `*` 标记有效项，并用 `global default is '<spec>'` 报告全局默认。
   —— 在 mcpp 2026.9.30.2 上已观察不到该 `global default` 行，解析器会退化为用"有效项"充当
   全局默认。
2. `mcpp toolchain list` 的每一行可用 `family version [/ version...]` 或 `family@version` 形式解析。
3. `mcpp new <name>` 的模板不做 TOML/C++ 转义，且名字包含 `PROJECT` 时模板替换不终止
   （mcpp#380）；`newProject.ts` 因此做名称白名单校验。
4. `--configure-only` 会写 `compile_commands.json`，成功条件是退出码 0 且该文件可解析。
