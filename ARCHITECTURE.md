# 架构与文件规模 / Architecture and file size

本文档记录模块边界、拆分策略和当前的大文件状态。它不替代 [CONTRIBUTING.md](./CONTRIBUTING.md)（开发流程与硬约束）和 [README.md](./README.md)（用户功能），只回答两个问题：代码放哪里，以及文件多大时该拆。

This document records module boundaries, the splitting policy, and the current state of the largest files. It complements [CONTRIBUTING.md](./CONTRIBUTING.md) (workflow and hard constraints) and [README.md](./README.md) (user-facing features); it answers two questions only: where code belongs, and when a file is large enough to split.

## 分层 / Layers

| 层 / Layer | 位置 / Location | 职责 / Responsibility |
| --- | --- | --- |
| 视图 / Views | `src/views/` | 路由页面，只做页面编排和跨组件组合 / route pages; orchestration only |
| 组件 / Components | `src/components/` | 可复用 UI、面板、对话框 / reusable UI, panels, dialogs |
| 组合式 / Composables | `src/composables/` | 可复用的有状态逻辑 / reusable stateful logic |
| 状态 / Stores | `src/stores/` | Pinia 单例，跨页面状态 / Pinia singletons for cross-page state |
| 领域 / Modules | `src/modules/` | 纯逻辑、平台映射、协议、缓存 / pure logic, platform mapping, protocols, caches |
| 工具 / Utils | `src/utils/` | 无业务语义的基础设施 / infrastructure without domain semantics |
| 后端 / Backend | `src-tauri/src/` | 平台请求、签名、播放、文件、凭据、同步 / platform I/O, signing, playback, files, credentials, sync |

前端不直接访问音乐平台，所有 IPC 命令在 `src-tauri/src/main.rs` 的 `generate_handler!` 注册一次；新增命令必须同时改命令实现、注册表和调用它的 store。

The frontend never talks to music platforms directly. Every IPC command is registered exactly once in `generate_handler!` in `src-tauri/src/main.rs`; a new command requires the implementation, the registration, and the store that calls it.

## 拆分策略 / Splitting policy

1. **先拆样式，再拆逻辑**：`.vue` 超过约 800 行时，先把 `<style scoped>` 移到同级 `.scss`，用 `<style scoped lang="scss" src="./X.scss">` 引用；样式拆分不改变行为，是最低风险的一步。
   Split styles first, logic second: once a `.vue` exceeds roughly 800 lines, move `<style scoped>` into a sibling `.scss` and reference it with `<style scoped lang="scss" src="./X.scss">`. This is behavior-neutral and the lowest-risk step.
2. **按 section 拆组件**：设置页、详情页这类“多个独立区块”的页面，每个区块一个 `Settings*Section.vue`，共用样式放 `styles/settings-common.scss`，折叠/滚动等页面级状态留在外壳。
   Split by section: for pages made of independent blocks (settings, detail pages), give each block a `Settings*Section.vue`, keep shared styles in `styles/settings-common.scss`, and leave page-level state (collapse, scroll) in the shell.
3. **按关注点拆 composable**：逻辑与模板强绑定但可以独立测试时，抽到 `src/composables/`，例如 `useSleepTimer`、`useExpandTransition`、`useExternalLink`。
   Split by concern into composables: when logic is bound to the template but testable on its own, move it to `src/composables/` (for example `useSleepTimer`, `useExpandTransition`, `useExternalLink`).
4. **状态机不硬拆**：播放队列、一起听会话这类带代际/因果 token 的状态机，拆文件必须连同不变量一起搬；没有运行时回归测试前，优先抽纯函数，不要为了行数把状态切成两半。
   Never split a state machine just for line count: playback queues and listen-together sessions carry generation/causal invariants. Without runtime regression coverage, extract pure helpers first instead of cutting state in half.
5. **Rust 先拆测试**：`#[cfg(test)] mod tests` 超过约 800 行时移到同级 `tests.rs`，生产文件与测试文件分离，测试仍用 `super::*`。
   Split Rust tests first: move `#[cfg(test)] mod tests` over roughly 800 lines into a sibling `tests.rs`; production and test files stay separate while tests still use `super::*`.

## 当前状态 / Current state

| 文件 / File | 行数 / Lines | 已做的拆分 / Split so far |
| --- | --- | --- |
| `src/components/NowPlaying.vue` | ~2980 | scoped + global 样式移出；右键菜单拆为 `NowPlayingContextMenu.vue` / styles externalized + context menu extracted |
| `src/components/NowPlayingContextMenu.vue` | ~260 | 标题/歌手菜单、封面保存与歌手跳转 / title/artist menu, cover export, artist navigation |
| `src/views/SettingsView.vue` | ~3150 | 样式移出；accounts/language/about/storage 四个 section / styles + four section components |
| `src/stores/player.ts` | ~3745 | 睡眠定时器抽为 `useSleepTimer` / sleep timer extracted |
| `src/stores/listenTogether/index.ts` | ~2215 | 协议、队列、重连、看门狗已在子模块 / protocol, queue, reconnect, watchdog already split |
| `src/views/LibraryView.vue` | ~1536 | 样式移出 / styles externalized |
| `src/modules/playback/playbackSource.ts` | ~1300 | 仍是单文件 / still single file |
| `src-tauri/src/audio/remote.rs` | ~4580 | 测试移到 `remote/tests.rs` / tests moved to `remote/tests.rs` |
| `src-tauri/src/audio/player.rs` | ~3810 | 测试移到 `player/tests.rs` / tests moved to `player/tests.rs` |
| `src-tauri/src/sync/merge.rs` | ~2160 | 测试移到 `merge/tests.rs` / tests moved to `merge/tests.rs` |
| `src-tauri/src/commands/sync_cmd.rs` | ~2050 | 测试移到 `sync_cmd/tests.rs` / tests moved to `sync_cmd/tests.rs` |

## 下一步拆分 / Next splits

这些文件仍然偏大，但都带状态机或跨模块契约，需要分阶段做：

The following files are still large, but each carries a state machine or a cross-module contract, so they need staged work:

- `stores/player.ts`：按“持久化 / 队列与随机 / 播放请求 / 预取 / 事件订阅”切，先搬纯函数与持久化上下文，再搬 `play()` 的分支；每一步都必须跑 `test:playback-request`、`test:playback-queue`、`test:player-state` 和 Rust 播放测试。
  Split by persistence / queue+shuffle / playback request / prefetch / event subscriptions. Move pure helpers and the persistence context first, then branches of `play()`; each step must run the playback/queue/player-state tests and the Rust playback tests.
- `stores/listenTogether/index.ts`：把会话生命周期、队列同步、心跳从 store 抽成控制器；协议与合并规则必须保持与 Android/Worker 兼容。
  Extract session lifecycle, queue sync and heartbeats into controllers; protocol and merge rules must stay compatible with Android and the Worker.
- `views/LibraryView.vue`：按 tab 拆（本地歌单、本地歌手、收藏、网易云、B 站、YouTube）；父组件只保留 tab 切换、搜索和对话框。
  Split by tab (local playlists, local artists, favorites, NetEase, Bilibili, YouTube); the parent keeps tab switching, search and dialogs.
- `modules/playback/playbackSource.ts`：按 `shared / netease / qq / bilibili / youtube / adapters` 拆；解析结果与缓存键是对外契约，拆分前后必须保持同一测试集通过。
  Split into `shared / netease / qq / bilibili / youtube / adapters`; resolution results and cache keys are external contracts, so the same tests must pass before and after.

任何拆分都受 `CONTRIBUTING.md` 的质量门禁约束：`pnpm test`、`pnpm build`、`cargo clippy -- -D warnings`、`cargo test --lib` 必须全绿。

Every split is bound by the quality gates in `CONTRIBUTING.md`: `pnpm test`, `pnpm build`, `cargo clippy -- -D warnings` and `cargo test --lib` must all pass.
