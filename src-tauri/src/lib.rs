//! NeriPlayer Desktop 后端库 / NeriPlayer Desktop backend library.
//!
//! 前端只负责界面与状态编排，平台请求、签名、播放、文件访问与凭据全部在本 crate。
//! The frontend owns UI and state orchestration only; platform requests, signing,
//! playback, file access and credentials all live in this crate.
//!
//! 模块地图 / Module map:
//! - `api`：平台客户端与签名（网易云 WEAPI/EAPI、B站 WBI、YouTube SAPISIDHASH、QQ、LRCLIB）
//!   platform clients and request signing.
//! - `audio`：cpal 输出、解码、HLS、DSP、响度、跨淡与播放队列
//!   output, decoding, HLS, DSP, loudness, crossfade and the playback queue.
//! - `commands`：唯一的 IPC 入口层，全部在 `main.rs` 的 `generate_handler!` 注册
//!   the only IPC entry layer, registered in one place in `main.rs`.
//! - `library` / `db` / `stats`：本地曲库、SQLite 缓存与播放统计
//!   local library, SQLite caches and playback statistics.
//! - `sync`：GitHub/WebDAV 同步，proto 字段号必须与 Android 端 1:1
//!   GitHub/WebDAV sync; proto field numbers must stay 1:1 with Android.
//! - `listen_together`：WebSocket 一起听，兼容 Android 客户端与 Workers 服务端
//!   listen-together over WebSocket, compatible with the Android client and Workers server.
//! - `security` / `fsutil`：凭据存储与原子落盘，所有持久化都必须走这两个模块
//!   credential storage and atomic writes; all persistence must go through them.
//! - `linux_graphics`：启动前检测 NVIDIA 并设置 WebKitGTK 兼容环境变量
//!   pre-start NVIDIA detection and WebKitGTK compatibility environment variables.
//!
//! 质量门禁见 `CONTRIBUTING.md` «质量门禁» 一节；新增命令、依赖或文件前先读一遍。
//! See the quality-gates section in `CONTRIBUTING.md` before adding commands,
//! dependencies or files.

pub mod api;
pub mod audio;
/// Linux WebKitGTK/NVIDIA 图形兼容（启动前设置环境变量）。
/// Linux WebKitGTK/NVIDIA graphics compatibility (sets env vars before startup).
#[cfg(target_os = "linux")]
pub mod linux_graphics;
pub mod auth;
pub mod commands;
pub mod db;
pub mod error;
pub mod fsutil;
pub mod library;
pub mod listen_together;
pub mod logging;
pub mod lyrics;
pub mod security;
pub mod settings;
pub mod state;
pub mod stats;
pub mod sync;
pub mod webview_args;
