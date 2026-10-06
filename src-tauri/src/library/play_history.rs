// 播放历史：SQLite 持久化（对齐 Android play_history）
//
// 前端「最近播放」按曲目 id 去重，最新的排在最前；删除记录单独保留，
// 同步时据此把删除传播到其它设备。曲目载荷以前端 TrackInfo 原样保存
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppResult;

pub const MAX_ENTRIES: i64 = 1000;
pub const MAX_DELETIONS: i64 = 2000;
pub(crate) const LEGACY_IMPORT_KEY: &str = "legacy_import.play_history";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub track: Value,
    pub played_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeletion {
    pub track: Value,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayHistory {
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
    #[serde(default)]
    pub deletions: Vec<HistoryDeletion>,
}

pub fn load_from(connection: &Connection) -> AppResult<PlayHistory> {
    let entries = connection
        .prepare(
            "SELECT track_payload_json, played_at FROM play_history
             ORDER BY played_at DESC, rowid DESC",
        )?
        .query_and_then([], |row| -> AppResult<HistoryEntry> {
            Ok(HistoryEntry {
                track: serde_json::from_str(&row.get::<_, String>(0)?)?,
                played_at: row.get(1)?,
            })
        })?
        .collect::<AppResult<Vec<_>>>()?;
    let deletions = connection
        .prepare(
            "SELECT track_payload_json, deleted_at FROM play_history_deletion
             ORDER BY deleted_at DESC, rowid DESC",
        )?
        .query_and_then([], |row| -> AppResult<HistoryDeletion> {
            Ok(HistoryDeletion {
                track: serde_json::from_str(&row.get::<_, String>(0)?)?,
                deleted_at: row.get(1)?,
            })
        })?
        .collect::<AppResult<Vec<_>>>()?;
    Ok(PlayHistory { entries, deletions })
}

/// 记录一次播放：同一曲目只保留最新一条，并撤销它的删除记录
pub fn record(transaction: &Transaction<'_>, track: &Value, played_at: i64) -> AppResult<bool> {
    let Some(id) = track_id(track) else { return Ok(false) };
    if played_at <= 0 {
        return Ok(false);
    }
    transaction.execute("DELETE FROM play_history_deletion WHERE track_id = ?1", [&id])?;
    insert_entry(transaction, &id, track, played_at)?;
    trim(transaction)?;
    Ok(true)
}

/// 删除单条历史，并留下删除记录供同步传播
pub fn remove(transaction: &Transaction<'_>, id: &str, deleted_at: i64) -> AppResult<bool> {
    let payload: Option<String> = transaction
        .query_row(
            "SELECT track_payload_json FROM play_history WHERE track_id = ?1",
            [id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            error => Err(error),
        })?;
    let Some(payload) = payload else { return Ok(false) };
    transaction.execute("DELETE FROM play_history WHERE track_id = ?1", [id])?;
    transaction.execute(
        "INSERT OR REPLACE INTO play_history_deletion (track_id, deleted_at, track_payload_json)
         VALUES (?1, ?2, ?3)",
        params![id, deleted_at.max(0), payload],
    )?;
    trim(transaction)?;
    Ok(true)
}

/// 清空历史：现有条目全部转成同一时间的删除记录
pub fn clear(transaction: &Transaction<'_>, deleted_at: i64) -> AppResult<bool> {
    let changed = transaction.execute(
        "INSERT OR REPLACE INTO play_history_deletion (track_id, deleted_at, track_payload_json)
         SELECT track_id, ?1, track_payload_json FROM play_history",
        [deleted_at.max(0)],
    )?;
    transaction.execute("DELETE FROM play_history", [])?;
    trim(transaction)?;
    Ok(changed > 0)
}

/// 用同步结果整体替换历史
pub fn replace(transaction: &Transaction<'_>, history: &PlayHistory) -> AppResult<()> {
    transaction.execute("DELETE FROM play_history", [])?;
    transaction.execute("DELETE FROM play_history_deletion", [])?;
    // 列表按新到旧给出，逆序插入使相同时间戳时仍保持原相对顺序
    for entry in history.entries.iter().rev() {
        if let Some(id) = track_id(&entry.track) {
            if entry.played_at > 0 {
                insert_entry(transaction, &id, &entry.track, entry.played_at)?;
            }
        }
    }
    for deletion in history.deletions.iter().rev() {
        if let Some(id) = track_id(&deletion.track) {
            if deletion.deleted_at > 0 {
                transaction.execute(
                    "INSERT OR REPLACE INTO play_history_deletion (track_id, deleted_at, track_payload_json)
                     VALUES (?1, ?2, ?3)",
                    params![id, deletion.deleted_at, serde_json::to_string(&deletion.track)?],
                )?;
            }
        }
    }
    trim(transaction)
}

fn insert_entry(transaction: &Transaction<'_>, id: &str, track: &Value, played_at: i64) -> AppResult<()> {
    transaction.execute("DELETE FROM play_history WHERE track_id = ?1", [id])?;
    transaction.execute(
        "INSERT INTO play_history (track_id, played_at, name, artist, album, duration_ms,
             cover_url, source, track_payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            played_at,
            text(track, &["title"]).unwrap_or_default(),
            text(track, &["artist"]).unwrap_or_default(),
            text(track, &["album"]).unwrap_or_default(),
            number(track, &["durationMs", "duration_ms"]),
            text(track, &["coverUrl", "cover_url"]).filter(|url| !url.is_empty()),
            text(track, &["source"]),
            serde_json::to_string(track)?,
        ],
    )?;
    Ok(())
}

fn trim(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute(
        "DELETE FROM play_history WHERE rowid NOT IN (
             SELECT rowid FROM play_history ORDER BY played_at DESC, rowid DESC LIMIT ?1)",
        [MAX_ENTRIES],
    )?;
    transaction.execute(
        "DELETE FROM play_history_deletion WHERE rowid NOT IN (
             SELECT rowid FROM play_history_deletion ORDER BY deleted_at DESC, rowid DESC LIMIT ?1)",
        [MAX_DELETIONS],
    )?;
    Ok(())
}

fn track_id(track: &Value) -> Option<String> {
    match &track["id"] {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

fn text(track: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| track[*key].as_str().map(str::to_string))
}

fn number(track: &Value, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| track[*key].as_f64())
        .map(|value| value.max(0.0).round() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::UserDatabase;
    use serde_json::json;

    fn track(id: &str) -> Value {
        json!({"id": id, "title": format!("Song {id}"), "artist": "A", "album": "B", "durationMs": 1000, "coverUrl": "", "source": "netease"})
    }

    #[test]
    fn record_deduplicates_and_orders_newest_first() {
        let database = UserDatabase::open_in_memory().unwrap();
        database
            .write(|transaction| {
                record(transaction, &track("netease:1"), 10)?;
                record(transaction, &track("netease:2"), 20)?;
                record(transaction, &track("netease:1"), 30)?;
                Ok(())
            })
            .unwrap();
        let history = database.read(load_from).unwrap();
        let ids: Vec<&str> = history.entries.iter().map(|entry| entry.track["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["netease:1", "netease:2"]);
        assert_eq!(history.entries[0].played_at, 30);
        assert_eq!(history.entries[0].track, track("netease:1"));
    }

    #[test]
    fn remove_and_clear_leave_deletions_and_record_revives() {
        let database = UserDatabase::open_in_memory().unwrap();
        database
            .write(|transaction| {
                record(transaction, &track("a"), 10)?;
                record(transaction, &track("b"), 20)?;
                assert!(remove(transaction, "a", 30)?);
                assert!(!remove(transaction, "missing", 31)?);
                assert!(clear(transaction, 40)?);
                record(transaction, &track("b"), 50)?;
                Ok(())
            })
            .unwrap();
        let history = database.read(load_from).unwrap();
        assert_eq!(history.entries.len(), 1);
        assert_eq!(history.entries[0].track["id"], "b");
        assert_eq!(history.deletions.len(), 1);
        assert_eq!(history.deletions[0].track["id"], "a");
        assert_eq!(history.deletions[0].deleted_at, 30);
    }

    #[test]
    fn replace_keeps_order_and_caps() {
        let database = UserDatabase::open_in_memory().unwrap();
        let entries: Vec<HistoryEntry> = (0..1005)
            .map(|index| HistoryEntry { track: track(&format!("t{index}")), played_at: 2000 - index })
            .collect();
        let history = PlayHistory {
            entries,
            deletions: vec![HistoryDeletion { track: track("gone"), deleted_at: 5 }],
        };
        database.write(|transaction| replace(transaction, &history)).unwrap();
        let restored = database.read(load_from).unwrap();
        assert_eq!(restored.entries.len(), MAX_ENTRIES as usize);
        assert_eq!(restored.entries[0].track["id"], "t0");
        assert_eq!(restored.deletions.len(), 1);
    }
}
