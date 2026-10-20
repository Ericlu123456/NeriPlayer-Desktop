//! 跨设备同步 / Cross-device sync.
//!
//! 兼容性是硬约束 / Compatibility is a hard constraint:
//! - `proto_models.rs` 的字段号与 Android `SyncDataModels.kt` 的 `@ProtoNumber` 1:1，
//!   只能新增字段，不能改号。
//!   Field numbers are 1:1 with Android's `@ProtoNumber`; add fields, never renumber.
//! - `merge.rs` 是三方合并，不能退化成 last-write-wins。
//!   `merge.rs` is a three-way merge, never last-write-wins.
//! - 旧快照缺字段按“未修改”处理。
//!   Missing fields in old snapshots mean “unchanged”.
//!
//! `github_api`/`webdav_api` 只是传输层，`manager` 负责编排，`archive` 是加密归档。
//! `github_api`/`webdav_api` are transport only; `manager` orchestrates; `archive`
//! holds the encrypted archive format.

pub mod models;
pub mod proto_models;
pub mod serializer;
pub mod github_api;
pub mod webdav_api;
pub mod merge;
pub mod manager;
pub mod archive;
pub mod webdav_archive;
pub mod cloud;
pub mod failure;
pub(crate) mod storage;
mod webdav_gc;
