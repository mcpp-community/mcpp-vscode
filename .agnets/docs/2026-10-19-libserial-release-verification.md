# LibSerial 与 0.8.0 release 验收

## 合入前实际验证

- 环境：Linux，真实 VS Code 1.132.0、mcpp 2026.10.16.3，CLI 日志实际使用 llvm@23.1.3。
- 独立项目 `.dev-profile/libserial-pr19`，初始清单没有依赖；使用 PR #19 的 VSIX，在真实包详情选择 `compat.libserial@1.0.0`，点击普通 Add。
- 磁盘清单新增 `[dependencies.compat] libserial = "1.0.0"`，按钮显示 Already declared 且禁用，不是仅执行 CLI 的替代验证。
- 最小示例以 `<libserial/SerialPort.h>` 为第一个 include，构造 `LibSerial::SerialPort` 并检查 `IsOpen()==false`，覆盖头文件、生成 shim、非内联构造/析构与链接。
- `mcpp build --cache=local -j 2` 成功，实际编译 compat.libserial 与消费者，约 3.93s；`mcpp run --cache=local` 输出 `compat.libserial: SerialPort constructed and closed`，退出码 0。不连接真实串口设备。
- 可复现入口：`tools/test-libserial-ui.mjs`；UI 截图、清单副本、构建/运行日志位于该项目的 `evidence/`。可通过 `MCPP_TEST_VSIX` 指定 release 下载件，在独立 `MCPP_TEST_PROJECT` / `MCPP_TEST_EXTENSIONS` 中复测；脚本校验安装版本并记录 VSIX SHA-256。

## 发布规则

- 版本 0.8.0，PR #19 使用 squash 合入，tag 必须指向合入后的 main，匹配 package.json 与 lockfile。
- tag 工作流运行测试、打包、归档检查、SHA-256，并发布 GitHub Release 与 Open VSX。仓库无 VSCE_PAT，Marketplace 由用户手动上传。
- 最终交付必须从 GitHub Release 下载 VSIX 与 SHA-256，校验后安装该文件并重新执行 Add/build/run，不以本地重打包件替代。
