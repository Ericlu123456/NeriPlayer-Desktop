// 本地歌单：SQLite 持久化（对齐 Android LocalPlaylistRoomStore）
//
// 歌单、成员、删除墓碑与 next_id 全部落在用户数据库。保存按成员载荷摘要做
// 增量写入：成员未变化的歌单只更新元数据行，不重写成员
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::db::{self, UserDatabase};
use crate::error::{AppError, AppResult};
use crate::state::{TrackInfo, TrackSource};
use crate::sync::models::{
    normalize_sync_causal_tokens,
    SyncPlaylistSongDeletion,
    SyncSong,
};

const MAX_SAFE_PLAYLIST_ID: i64 = (1_i64 << 53) - 1;
const NEXT_ID_KEY: &str = "local_playlist.next_id";
const SONG_DELETIONS_HASH_KEY: &str = "local_playlist.song_deletions_hash";
pub(crate) const LEGACY_IMPORT_KEY: &str = "legacy_import.playlists";
const LEGACY_FILE: &str = "playlists.json";

static PLAYLIST_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PLAYLIST_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 串行化歌单读改写与同步应用，避免并发命令互相覆盖
pub(crate) fn lock_io() -> MutexGuard<'static, ()> {
    PLAYLIST_IO_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 返回进程内歌单写入版本，用于检测同步网络窗口中的本地编辑
pub(crate) fn io_epoch() -> u64 {
    PLAYLIST_EPOCH.load(Ordering::Acquire)
}

pub(crate) fn mark_io_changed() {
    PLAYLIST_EPOCH.fetch_add(1, Ordering::AcqRel);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub tracks: Vec<TrackInfo>,
    pub modified_at: u64,
}

/// 歌单列表摘要：曲目数与封面在写入时预先计算，列表页无需解析成员
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistSummary {
    pub id: i64,
    pub name: String,
    pub track_count: usize,
    pub modified_at: u64,
    pub cover_url: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PlaylistStore {
    pub playlists: Vec<Playlist>,
    #[serde(default)]
    pub deleted_playlist_ids: Vec<i64>,
    #[serde(default)]
    pub playlist_song_deletions: Vec<SyncPlaylistSongDeletion>,
    #[serde(default)]
    next_id: i64,
}

impl PlaylistStore {
    /// 读取完整歌单库；数据库不可用时报错，绝不返回空库
    ///
    /// 以空库继续会被后续保存或同步放大成全量删除
    pub fn load() -> AppResult<Self> {
        db::user_db()?.read(Self::load_from)
    }

    pub fn load_from(connection: &Connection) -> AppResult<Self> {
        let mut playlists = Vec::new();
        let mut positions = HashMap::new();
        {
            let mut statement = connection.prepare(
                "SELECT playlist_id, name, modified_at FROM local_playlist
                 ORDER BY display_position, playlist_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            })?;
            for row in rows {
                let (id, name, modified_at) = row?;
                positions.insert(id, playlists.len());
                playlists.push(Playlist {
                    id,
                    name,
                    tracks: Vec::new(),
                    modified_at: modified_at.max(0) as u64,
                });
            }
        }
        {
            let mut statement = connection.prepare(
                "SELECT playlist_id, member_payload_json FROM playlist_member
                 ORDER BY playlist_id, display_position",
            )?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let playlist_id: i64 = row.get(0)?;
                let Some(&position) = positions.get(&playlist_id) else { continue };
                playlists[position].tracks.push(parse_member(&row.get::<_, String>(1)?)?);
            }
        }
        let deleted_playlist_ids = connection
            .prepare(
                "SELECT playlist_id FROM local_playlist_deletion ORDER BY deleted_at, playlist_id",
            )?
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let playlist_song_deletions = connection
            .prepare("SELECT deletion_payload_json FROM playlist_song_deletion ORDER BY position")?
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|payload| -> AppResult<SyncPlaylistSongDeletion> {
                Ok(serde_json::from_str(&payload?)?)
            })
            .collect::<AppResult<Vec<_>>>()?;
        let mut store = Self {
            playlists,
            deleted_playlist_ids,
            playlist_song_deletions,
            next_id: db::meta::get_i64(connection, NEXT_ID_KEY)?.unwrap_or(0),
        };
        store.fix_next_id();
        Ok(store)
    }

    pub fn save(&self) -> AppResult<()> {
        let _guard = lock_io();
        self.save_locked()
    }

    /// 在已持有 `lock_io` 时写入，避免同步应用检查 epoch 后再次获取同一把锁
    pub(crate) fn save_locked(&self) -> AppResult<()> {
        self.save_with(db::user_db()?)
    }

    fn save_with(&self, database: &UserDatabase) -> AppResult<()> {
        database.write(|transaction| self.save_into(transaction))?;
        mark_io_changed();
        Ok(())
    }

    /// 持有歌单锁完成「读取 → 修改 → 写入」，闭包返回 (结果, 是否需要保存)
    ///
    /// 读和写之间不放锁，两个并发命令不会各自基于旧快照互相覆盖
    pub fn update<T>(mutation: impl FnOnce(&mut Self) -> AppResult<(T, bool)>) -> AppResult<T> {
        let _guard = lock_io();
        let mut store = Self::load()?;
        let (value, changed) = mutation(&mut store)?;
        if changed {
            store.save_locked()?;
        }
        Ok(value)
    }

    pub fn save_into(&self, transaction: &Transaction<'_>) -> AppResult<()> {
        let stored_hashes: HashMap<i64, i64> = transaction
            .prepare("SELECT playlist_id, members_hash FROM local_playlist")?
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut kept = HashSet::new();
        for (position, playlist) in self.playlists.iter().enumerate() {
            if !kept.insert(playlist.id) {
                return Err(AppError::Other(format!(
                    "Duplicate local playlist id {} cannot be stored",
                    playlist.id
                )));
            }
            let payloads = playlist
                .tracks
                .iter()
                .map(serde_json::to_string)
                .collect::<Result<Vec<_>, _>>()?;
            let hash = payload_hash(&payloads);
            let is_system = crate::sync::manager::is_system_playlist(playlist.id, &playlist.name);
            if stored_hashes.get(&playlist.id) == Some(&hash) {
                transaction.execute(
                    "UPDATE local_playlist SET name = ?2, display_position = ?3, modified_at = ?4,
                     is_system = ?5 WHERE playlist_id = ?1",
                    params![
                        playlist.id,
                        playlist.name,
                        position as i64,
                        clamp_u64(playlist.modified_at),
                        is_system,
                    ],
                )?;
                continue;
            }
            let (track_count, cover_url) = summarize_tracks(&playlist.tracks);
            transaction.execute(
                "INSERT INTO local_playlist (playlist_id, name, display_position, modified_at,
                     is_system, track_count, cover_url, members_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(playlist_id) DO UPDATE SET name = excluded.name,
                     display_position = excluded.display_position,
                     modified_at = excluded.modified_at, is_system = excluded.is_system,
                     track_count = excluded.track_count, cover_url = excluded.cover_url,
                     members_hash = excluded.members_hash",
                params![
                    playlist.id,
                    playlist.name,
                    position as i64,
                    clamp_u64(playlist.modified_at),
                    is_system,
                    track_count as i64,
                    cover_url,
                    hash,
                ],
            )?;
            transaction.execute("DELETE FROM playlist_member WHERE playlist_id = ?1", [playlist.id])?;
            let mut insert = transaction.prepare_cached(
                "INSERT INTO playlist_member (playlist_id, display_position, identity_key, track_id,
                     source, name, artist, album, duration_ms, cover_url, media_uri, added_at,
                     member_payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )?;
            for (member_position, (track, payload)) in playlist.tracks.iter().zip(&payloads).enumerate() {
                insert.execute(params![
                    playlist.id,
                    member_position as i64,
                    crate::sync::manager::playlist_track_identity_key_pub(track),
                    track.id,
                    source_key(&track.source),
                    track.title,
                    track.artist,
                    track.album,
                    clamp_u64(track.duration_ms),
                    track.cover_url,
                    (!track.url.is_empty()).then_some(track.url.as_str()),
                    track.added_at,
                    payload,
                ])?;
            }
        }
        for id in stored_hashes.keys().filter(|id| !kept.contains(id)) {
            transaction.execute("DELETE FROM local_playlist WHERE playlist_id = ?1", [id])?;
        }
        self.save_deletions_into(transaction)?;
        db::meta::set_i64(transaction, NEXT_ID_KEY, self.next_id)?;
        Ok(())
    }

    fn save_deletions_into(&self, transaction: &Transaction<'_>) -> AppResult<()> {
        // 墓碑时间只在首次删除时记录，后续保存沿用原值
        let stored: HashMap<i64, i64> = transaction
            .prepare("SELECT playlist_id, deleted_at FROM local_playlist_deletion")?
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?
            .collect::<Result<_, _>>()?;
        let now = chrono::Utc::now().timestamp_millis();
        transaction.execute("DELETE FROM local_playlist_deletion", [])?;
        for id in &self.deleted_playlist_ids {
            transaction.execute(
                "INSERT OR IGNORE INTO local_playlist_deletion (playlist_id, deleted_at) VALUES (?1, ?2)",
                params![id, stored.get(id).copied().unwrap_or(now)],
            )?;
        }

        let payloads = self
            .playlist_song_deletions
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()?;
        let hash = payload_hash(&payloads);
        if db::meta::get_i64(transaction, SONG_DELETIONS_HASH_KEY)? == Some(hash) {
            return Ok(());
        }
        transaction.execute("DELETE FROM playlist_song_deletion", [])?;
        let mut insert = transaction.prepare_cached(
            "INSERT INTO playlist_song_deletion (position, playlist_id, song_identity_key,
                 deleted_at, device_id, deletion_payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (position, (deletion, payload)) in self.playlist_song_deletions.iter().zip(&payloads).enumerate() {
            insert.execute(params![
                position as i64,
                deletion.playlist_id,
                deletion.song_identity_key(),
                deletion.deleted_at,
                deletion.device_id,
                payload,
            ])?;
        }
        db::meta::set_i64(transaction, SONG_DELETIONS_HASH_KEY, hash)
    }

    pub fn create(&mut self, name: String) -> &Playlist {
        let id = self.allocate_id();
        self.next_id = self.next_id.max(id.saturating_add(1));
        self.playlists.push(Playlist {
            id,
            name,
            tracks: Vec::new(),
            modified_at: chrono::Utc::now().timestamp_millis() as u64,
        });
        self.deleted_playlist_ids.retain(|deleted_id| *deleted_id != id);
        self.playlists.last().unwrap()
    }

    /// 53 位随机 ID 可被 JavaScript 精确表示，并避免多台设备从同一序号开始
    pub(crate) fn allocate_id(&self) -> i64 {
        loop {
            let bytes = uuid::Uuid::new_v4().into_bytes();
            let candidate = (u64::from_be_bytes(bytes[..8].try_into().expect("UUID prefix"))
                & MAX_SAFE_PLAYLIST_ID as u64) as i64;
            if candidate > 0 && self.playlists.iter().all(|playlist| playlist.id != candidate) {
                break candidate;
            }
        }
    }

    pub fn delete(&mut self, id: i64) -> bool {
        let len = self.playlists.len();
        self.playlists.retain(|p| p.id != id);
        let deleted = self.playlists.len() < len;
        if deleted && !self.deleted_playlist_ids.contains(&id) {
            self.deleted_playlist_ids.push(id);
        }
        deleted
    }

    pub fn record_playlist_song_deletion(&mut self, deletion: SyncPlaylistSongDeletion) {
        let mut deletion = deletion;
        deletion.removed_membership_tokens = normalize_sync_causal_tokens(
            &deletion.removed_membership_tokens,
        );
        let identity = deletion.identity();

        if deletion.removed_membership_tokens.is_empty() {
            if let Some(existing) = self.playlist_song_deletions.iter_mut().find(|existing| {
                existing.identity() == identity && existing.removed_membership_tokens.is_empty()
            }) {
                if deletion_snapshot_cmp(&deletion, existing).is_ge() {
                    *existing = deletion;
                }
            } else {
                self.playlist_song_deletions.push(deletion);
            }
            return;
        }

        let mut causal_snapshots: Vec<SyncPlaylistSongDeletion> = self
            .playlist_song_deletions
            .iter()
            .filter(|existing| {
                existing.identity() == identity
                    && !existing.removed_membership_tokens.is_empty()
            })
            .cloned()
            .collect();
        causal_snapshots.push(deletion);
        let mut merged = causal_snapshots
            .iter()
            .max_by(|left, right| deletion_snapshot_cmp(left, right))
            .cloned()
            .expect("causal deletion snapshot must exist");
        merged.removed_membership_tokens = normalize_sync_causal_tokens(
            &causal_snapshots
                .iter()
                .flat_map(|snapshot| snapshot.removed_membership_tokens.iter().cloned())
                .collect::<Vec<_>>(),
        );
        self.playlist_song_deletions.retain(|existing| {
            existing.identity() != identity || existing.removed_membership_tokens.is_empty()
        });
        self.playlist_song_deletions.push(merged);
    }

    pub fn clear_playlist_song_deletion(&mut self, playlist_id: &str, song: &SyncSong) {
        self.playlist_song_deletions.retain(|deletion| {
            !deletion.matches_song(playlist_id, song)
                || !deletion.removed_membership_tokens.is_empty()
        });
    }

    /// 确保 next_id 大于所有正数歌单 ID
    pub fn fix_next_id(&mut self) {
        let max = self.playlists.iter().map(|p| p.id).filter(|&id| id > 0).max().unwrap_or(0);
        if self.next_id <= max {
            self.next_id = max + 1;
        }
        if self.next_id < 1 { self.next_id = 1; }
    }

    /// 旧文件或外部导入可能带入重复 ID，后出现的歌单换发新 ID 而不是被覆盖
    fn reassign_duplicate_ids(&mut self) -> usize {
        let mut seen = HashSet::new();
        let mut reassigned = 0;
        for index in 0..self.playlists.len() {
            if seen.insert(self.playlists[index].id) {
                continue;
            }
            let id = self.allocate_id();
            seen.insert(id);
            self.playlists[index].id = id;
            reassigned += 1;
        }
        reassigned
    }
}

/// 歌单列表摘要（按展示顺序）
pub fn list_summaries() -> AppResult<Vec<PlaylistSummary>> {
    db::user_db()?.read(list_summaries_from)
}

fn list_summaries_from(connection: &Connection) -> AppResult<Vec<PlaylistSummary>> {
    let mut statement = connection.prepare(
        "SELECT playlist_id, name, track_count, modified_at, cover_url FROM local_playlist
         ORDER BY display_position, playlist_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(PlaylistSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            track_count: row.get::<_, i64>(2)?.max(0) as usize,
            modified_at: row.get::<_, i64>(3)?.max(0) as u64,
            cover_url: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 单个歌单的成员；歌单不存在时返回 None
pub fn load_playlist_tracks(playlist_id: i64) -> AppResult<Option<Vec<TrackInfo>>> {
    db::user_db()?.read(|connection| load_playlist_tracks_from(connection, playlist_id))
}

fn load_playlist_tracks_from(connection: &Connection, playlist_id: i64) -> AppResult<Option<Vec<TrackInfo>>> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM local_playlist WHERE playlist_id = ?1",
            [playlist_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT member_payload_json FROM playlist_member WHERE playlist_id = ?1
         ORDER BY display_position",
    )?;
    let payloads = statement
        .query_map([playlist_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    payloads.iter().map(|payload| parse_member(payload)).collect::<AppResult<_>>().map(Some)
}

/// 全部歌单成员（按歌单展示顺序拼接），可选按来源过滤
pub fn load_all_tracks(source: Option<TrackSource>) -> AppResult<Vec<TrackInfo>> {
    db::user_db()?.read(|connection| load_all_tracks_from(connection, source.as_ref()))
}

fn load_all_tracks_from(connection: &Connection, source: Option<&TrackSource>) -> AppResult<Vec<TrackInfo>> {
    let mut statement = connection.prepare(
        "SELECT member.member_payload_json FROM playlist_member AS member
         JOIN local_playlist AS playlist ON playlist.playlist_id = member.playlist_id
         WHERE ?1 IS NULL OR member.source = ?1
         ORDER BY playlist.display_position, playlist.playlist_id, member.display_position",
    )?;
    let payloads = statement
        .query_map([source.map(source_key)], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    payloads.iter().map(|payload| parse_member(payload)).collect()
}

/// 旧版 playlists.json 一次性导入
pub(crate) fn import_legacy_json(transaction: &Transaction<'_>, directory: &Path) -> AppResult<Vec<PathBuf>> {
    let path = directory.join(LEGACY_FILE);
    let Some(mut store) = db::legacy::read_json::<PlaylistStore>(&path)? else {
        return Ok(Vec::new());
    };
    let reassigned = store.reassign_duplicate_ids();
    if reassigned > 0 {
        log::warn!(target: "playlist-io", "旧版歌单存在 {reassigned} 个重复 ID, 已换发新 ID 保留");
    }
    store.fix_next_id();
    store.save_into(transaction)?;
    log::info!(
        target: "playlist-io",
        "旧版歌单已导入数据库: playlists={}, tracks={}",
        store.playlists.len(),
        store.playlists.iter().map(|playlist| playlist.tracks.len()).sum::<usize>(),
    );
    Ok(vec![path])
}

fn parse_member(payload: &str) -> AppResult<TrackInfo> {
    serde_json::from_str(payload).map_err(|error| {
        AppError::Other(format!("Stored playlist member is invalid: {error}"))
    })
}

fn summarize_tracks(tracks: &[TrackInfo]) -> (usize, Option<String>) {
    let mut seen = HashSet::new();
    let track_count = tracks
        .iter()
        .filter(|track| {
            !track.id.is_empty()
                && seen.insert(crate::sync::manager::playlist_track_identity_key_pub(track))
        })
        .count();
    let cover_url = tracks.iter().find_map(|track| {
        track
            .cover_url
            .as_ref()
            .filter(|url| !url.trim().is_empty())
            .cloned()
    });
    (track_count, cover_url)
}

pub(crate) fn source_key(source: &TrackSource) -> &'static str {
    match source {
        TrackSource::Local => "local",
        TrackSource::Netease => "netease",
        TrackSource::Qq => "qq",
        TrackSource::Bilibili => "bilibili",
        TrackSource::Youtube => "youtube",
    }
}

/// 成员载荷摘要，只用于判断是否需要重写成员，不参与任何身份计算
pub(crate) fn payload_hash(payloads: &[String]) -> i64 {
    let mut hasher = std::hash::DefaultHasher::new();
    payloads.len().hash(&mut hasher);
    for payload in payloads {
        payload.hash(&mut hasher);
    }
    hasher.finish() as i64
}

fn clamp_u64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn deletion_snapshot_cmp(
    left: &SyncPlaylistSongDeletion,
    right: &SyncPlaylistSongDeletion,
) -> std::cmp::Ordering {
    left.deleted_at
        .cmp(&right.deleted_at)
        .then_with(|| left.device_id.cmp(&right.device_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::models::SyncCausalToken;

    #[test]
    fn new_playlist_ids_are_cross_device_safe_and_javascript_exact() {
        let mut store = PlaylistStore::default();
        let first = store.create("First".into()).id;
        let second = store.create("Second".into()).id;

        assert!(first > 0);
        assert!(first <= MAX_SAFE_PLAYLIST_ID);
        assert!(second > 0);
        assert!(second <= MAX_SAFE_PLAYLIST_ID);
        assert_ne!(second, first);
    }

    #[test]
    fn store_round_trips_tracks_tombstones_and_next_id() {
        let database = UserDatabase::open_in_memory().unwrap();
        let mut store = PlaylistStore::default();
        let id = store.create("Mix".into()).id;
        store.playlists[0].tracks = vec![track("netease:1", "Cover"), local_track("C:/Music/a.flac")];
        store.deleted_playlist_ids.push(77);
        store.record_playlist_song_deletion(deletion(100, "phone", vec![token("phone", 2)]));

        store.save_with(&database).unwrap();
        let restored = database.read(PlaylistStore::load_from).unwrap();

        assert_eq!(restored.playlists.len(), 1);
        assert_eq!(restored.playlists[0].id, id);
        assert_eq!(restored.playlists[0].name, "Mix");
        assert_eq!(
            serde_json::to_value(&restored.playlists[0].tracks).unwrap(),
            serde_json::to_value(&store.playlists[0].tracks).unwrap(),
        );
        assert_eq!(restored.deleted_playlist_ids, vec![77]);
        assert_eq!(restored.playlist_song_deletions.len(), 1);
        assert_eq!(restored.next_id, store.next_id);
    }

    #[test]
    fn unchanged_playlists_keep_their_member_rows() {
        let database = UserDatabase::open_in_memory().unwrap();
        let mut store = PlaylistStore::default();
        store.create("Stable".into());
        store.create("Edited".into());
        store.playlists[0].tracks = vec![track("netease:1", "")];
        store.playlists[1].tracks = vec![track("netease:2", "")];
        store.save_with(&database).unwrap();

        // 篡改一行成员：未变化的歌单不会被重写，篡改结果应当保留
        database
            .write(|transaction| {
                transaction.execute(
                    "UPDATE playlist_member SET name = 'untouched' WHERE playlist_id = ?1",
                    [store.playlists[0].id],
                )?;
                Ok(())
            })
            .unwrap();
        store.playlists[1].tracks.push(track("netease:3", ""));
        store.save_with(&database).unwrap();

        let names: Vec<String> = database
            .read(|connection| {
                Ok(connection
                    .prepare("SELECT name FROM playlist_member ORDER BY playlist_id = ?1 DESC, display_position")?
                    .query_map([store.playlists[0].id], |row| row.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .unwrap();
        assert_eq!(names[0], "untouched");
        assert_eq!(names.len(), 3);
    }

    #[test]
    fn summaries_count_unique_tracks_and_pick_first_cover() {
        let database = UserDatabase::open_in_memory().unwrap();
        let mut store = PlaylistStore::default();
        store.create("Covers".into());
        store.playlists[0].tracks = vec![
            track("netease:1", " "),
            track("netease:1", "https://dup"),
            track("netease:2", "https://second"),
        ];
        store.save_with(&database).unwrap();

        let summaries = database.read(list_summaries_from).unwrap();
        assert_eq!(summaries[0].track_count, 2);
        assert_eq!(summaries[0].cover_url.as_deref(), Some("https://dup"));
    }

    #[test]
    fn removed_playlists_cascade_their_members() {
        let database = UserDatabase::open_in_memory().unwrap();
        let mut store = PlaylistStore::default();
        let id = store.create("Gone".into()).id;
        store.playlists[0].tracks = vec![track("netease:1", "")];
        store.save_with(&database).unwrap();
        assert!(store.delete(id));
        store.save_with(&database).unwrap();

        let members: i64 = database
            .read(|connection| {
                Ok(connection.query_row("SELECT COUNT(*) FROM playlist_member", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(members, 0);
        assert_eq!(database.read(PlaylistStore::load_from).unwrap().deleted_playlist_ids, vec![id]);
    }

    #[test]
    fn source_queries_follow_playlist_display_order() {
        let database = UserDatabase::open_in_memory().unwrap();
        let mut store = PlaylistStore::default();
        store.create("First".into());
        store.create("Second".into());
        store.playlists[0].tracks = vec![local_track("C:/a.flac"), track("netease:9", "")];
        store.playlists[1].tracks = vec![local_track("C:/b.flac")];
        store.playlists.swap(0, 1);
        store.save_with(&database).unwrap();

        let local = database
            .read(|connection| load_all_tracks_from(connection, Some(&TrackSource::Local)))
            .unwrap();
        assert_eq!(local.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(), ["C:/b.flac", "C:/a.flac"]);
        let all = database.read(|connection| load_all_tracks_from(connection, None)).unwrap();
        assert_eq!(all.len(), 3);
        let first = store.playlists[0].id;
        assert_eq!(
            database.read(|connection| load_playlist_tracks_from(connection, first)).unwrap().unwrap().len(),
            1
        );
        assert!(database.read(|connection| load_playlist_tracks_from(connection, 404)).unwrap().is_none());
    }

    #[test]
    fn legacy_json_is_imported_with_duplicate_ids_preserved() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(LEGACY_FILE),
            serde_json::to_vec(&serde_json::json!({
                "playlists": [
                    {"id": 5, "name": "A", "tracks": [serde_json::to_value(track("netease:1", "")).unwrap()], "modified_at": 10},
                    {"id": 5, "name": "B", "tracks": [], "modified_at": 11}
                ],
                "deleted_playlist_ids": [9],
                "playlist_song_deletions": [],
                "next_id": 6
            }))
            .unwrap(),
        )
        .unwrap();
        let database = UserDatabase::open_in_memory().unwrap();

        assert!(db::legacy::run_once(&database, directory.path(), LEGACY_IMPORT_KEY, import_legacy_json).unwrap());
        let store = database.read(PlaylistStore::load_from).unwrap();
        assert_eq!(store.playlists.len(), 2);
        assert_eq!(store.playlists[0].id, 5);
        assert_ne!(store.playlists[1].id, 5);
        assert_eq!(store.playlists[1].name, "B");
        assert_eq!(store.playlists[0].tracks[0].id, "netease:1");
        assert_eq!(store.deleted_playlist_ids, vec![9]);
        assert!(!directory.path().join(LEGACY_FILE).exists());
    }

    #[test]
    fn corrupt_legacy_json_is_quarantined_and_never_silently_reimported() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(LEGACY_FILE), b"{ this is not json").unwrap();
        let database = UserDatabase::open_in_memory().unwrap();

        db::legacy::run_once(&database, directory.path(), LEGACY_IMPORT_KEY, import_legacy_json).unwrap();
        assert!(database.read(PlaylistStore::load_from).unwrap().playlists.is_empty());
        let quarantined = std::fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined, "a .corrupt-* file must be preserved");
    }

    #[test]
    fn duplicate_ids_are_rejected_instead_of_overwriting() {
        let database = UserDatabase::open_in_memory().unwrap();
        let mut store = PlaylistStore::default();
        store.create("One".into());
        let duplicate = Playlist { name: "Two".into(), ..store.playlists[0].clone() };
        store.playlists.push(duplicate);
        assert!(store.save_with(&database).is_err());
        assert!(database.read(PlaylistStore::load_from).unwrap().playlists.is_empty());
    }

    #[test]
    fn causal_deletion_snapshots_union_all_observed_tokens() {
        let mut store = PlaylistStore::default();
        store.record_playlist_song_deletion(deletion(
            100,
            "a",
            vec![token("phone", 1)],
        ));
        store.record_playlist_song_deletion(deletion(
            200,
            "b",
            vec![token("desktop", 1)],
        ));

        let merged = &store.playlist_song_deletions[0];
        assert_eq!(merged.deleted_at, 200);
        assert_eq!(merged.device_id, "b");
        assert_eq!(
            merged.removed_membership_tokens,
            vec![token("desktop", 1), token("phone", 1)]
        );
    }

    #[test]
    fn readd_clears_only_legacy_deletion_snapshot() {
        let mut store = PlaylistStore::default();
        store.record_playlist_song_deletion(deletion(100, "legacy", Vec::new()));
        store.record_playlist_song_deletion(deletion(
            200,
            "phone",
            vec![token("phone", 1)],
        ));
        let song = SyncSong {
            id: "42".into(),
            album: "netease".into(),
            ..Default::default()
        };

        store.clear_playlist_song_deletion("1", &song);

        assert_eq!(store.playlist_song_deletions.len(), 1);
        assert_eq!(
            store.playlist_song_deletions[0].removed_membership_tokens,
            vec![token("phone", 1)]
        );
    }

    #[test]
    fn save_advances_io_epoch() {
        let database = UserDatabase::open_in_memory().unwrap();
        let before = io_epoch();
        PlaylistStore::default().save_with(&database).unwrap();
        assert!(io_epoch() > before);
    }

    fn deletion(
        deleted_at: i64,
        device_id: &str,
        removed_membership_tokens: Vec<SyncCausalToken>,
    ) -> SyncPlaylistSongDeletion {
        SyncPlaylistSongDeletion {
            playlist_id: "1".into(),
            song_id: "42".into(),
            album: "netease".into(),
            deleted_at,
            device_id: device_id.into(),
            removed_membership_tokens,
            ..Default::default()
        }
    }

    fn token(device_id: &str, counter: i64) -> SyncCausalToken {
        SyncCausalToken {
            device_id: device_id.into(),
            counter,
        }
    }

    fn track(id: &str, cover: &str) -> TrackInfo {
        TrackInfo {
            id: id.into(),
            title: format!("Title {id}"),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_ms: 1_000,
            source: TrackSource::Netease,
            url: String::new(),
            cover_url: (!cover.is_empty()).then(|| cover.to_string()),
            added_at: 5,
            sync_payload: None,
            playlist_key: None,
        }
    }

    fn local_track(path: &str) -> TrackInfo {
        TrackInfo {
            id: path.into(),
            source: TrackSource::Local,
            url: path.into(),
            ..track(path, "")
        }
    }
}
