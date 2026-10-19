# Modules graph 0.9.0 validation and review

Status: implementation and local review complete. The repository suite passes 725 tests; Chromium passes 11 interaction/export groups. Exact-head CI and released-artifact verification are final release gates.

## Review perspectives

| Perspective | Findings addressed | Evidence |
| --- | --- | --- |
| Graph semantics | Test-root budget starvation; parent traversal bringing sibling dependencies; edge limits stranding nodes; library classification based on target spelling | Graph/model and module provider regressions; large-project projection |
| Interaction | Click opening files; repeated expansion doing nothing; selected/focus/camera ambiguity; initial root centering overriding Fit; test paging lingering after entry focus | Chromium canvas tests; real VS Code fixture navigation; host regression for leaving the pager and restoring its page with Back |
| Refresh and concurrency | Event bursts starting duplicate reads; lock changes querying Modules; hidden refreshes; old view publications arriving after a project switch | Refresh coordinator tests and the real host module under a controlled message transport |
| Project state | Empty declarations removing the row; incomplete manifests clearing usable dependencies; delayed project switching exposing old actions | Dependency state tests; immediate cross-project update; real VS Code empty → ready → stale → ready checks with the installed VSIX |
| Cache correctness | Identical SVGs in different projects retaining old node identities | Chromium test proves layout reuse with new event bindings |
| Export | Theme variables missing offline; transformed/cropped drawing; excessive raster size | Light/dark standalone SVG and PNG, decoded dimensions, Unicode and marker inspection |
| Compatibility | Shared Packages canvas, read-only source documents, old language service commands | Existing unit and five service-variant Extension Host suites; real source read-only checks |
| Release and privacy | Local paths in the initial design; accidental Marketplace publication; packaged local evidence | Sanitized design, manual Marketplace workflow, archive inclusion/size gates |

## Local measurements

The mcpp baseline snapshot contains 343 retained nodes and 1,648 imports. Its roots include 149 test files. The old initial projection has 150 nodes and zero edges. The new Main projection has 51 nodes and 80 edges; complete source data remains available behind focus and paging.

Twenty fresh layouts using shipped Mermaid in Chromium measured median 163 ms and p95 171 ms for that real projection. These measurements include smaller budgets and removal of repeated import labels; they do not claim an equally sized layout algorithm became faster. Wide, shared and many-test synthetic samples also stay within the initial layout target.

The simplified toolbar combines formats and Mermaid copy under Export, moves depth controls into View options, and exposes node operations through the node context menu. Chromium checks cover right-click targeting, Shift+F10, arrow navigation, dismissal and focus restoration, plus control alignment and distinct theme colors.

A local native watcher resource exhaustion reproduced missing file events. The sidebar now supplements watchers and editor saves with two metadata stamps every two seconds while visible. Unchanged stamps cause no CLI query or layout. A real subprocess cancellation check also verifies that aborting a provider read terminates the child process.

Cold CLI queries still depend on mcppls indexing. No fan-speed or whole-editor power claim is made. Incomplete snapshots remain explicit; unchanged partial results stop automatic retrying.

## Required final gates

- Full repository consistency/unit suite and the new Chromium job.
- Existing Linux/macOS/Windows Extension Host and isolated VSIX install jobs, package guards and upstream drift check.
- Real VS Code large-project entry/test paging and selected-node focus: passed locally with the installed VSIX; repeat on the released artifact.
- Squash merge followed by successful tag release, GitHub/Open VSX artifact verification and local validation of the exact released VSIX.

Local screenshots and raw fixtures remain ignored development artifacts. Public evidence uses fixture names and aggregate statistics, without machine paths or editor profile data.
