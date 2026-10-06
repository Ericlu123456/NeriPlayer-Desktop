// 逐曲歌词偏移（用户 delta）：SQLite 持久化
//
// 只保存手动调整过的曲目，delta 归零即删除记录；有效偏移 = 来源默认偏移 + delta
use std::collections::BTreeMap;

use rusqlite::{params, Connection, Transaction};

use crate::error::AppResult;

pub(crate) const LEGACY_IMPORT_KEY: &str = "legacy_import.lyric_offsets";

pub fn load_from(connection: &Connection) -> AppResult<BTreeMap<String, i64>> {
    Ok(connection
        .prepare("SELECT track_key, offset_ms FROM lyric_offset")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?)
}

pub fn set(transaction: &Transaction<'_>, track_key: &str, offset_ms: i64) -> AppResult<()> {
    if track_key.is_empty() {
        return Ok(());
    }
    if offset_ms == 0 {
        transaction.execute("DELETE FROM lyric_offset WHERE track_key = ?1", [track_key])?;
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO lyric_offset (track_key, offset_ms, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(track_key) DO UPDATE SET offset_ms = excluded.offset_ms, updated_at = excluded.updated_at",
        params![track_key, offset_ms, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// 默认偏移变化后整体 rebase 时使用
pub fn replace(transaction: &Transaction<'_>, offsets: &BTreeMap<String, i64>) -> AppResult<()> {
    transaction.execute("DELETE FROM lyric_offset", [])?;
    for (key, offset) in offsets {
        set(transaction, key, *offset)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::UserDatabase;

    #[test]
    fn zero_offsets_are_not_stored() {
        let database = UserDatabase::open_in_memory().unwrap();
        database
            .write(|transaction| {
                set(transaction, "netease:1", 300)?;
                set(transaction, "netease:2", -50)?;
                set(transaction, "netease:2", 0)?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            database.read(load_from).unwrap(),
            BTreeMap::from([("netease:1".to_string(), 300)])
        );
        database
            .write(|transaction| replace(transaction, &BTreeMap::from([("qq:1".into(), 10), ("qq:2".into(), 0)])))
            .unwrap();
        assert_eq!(database.read(load_from).unwrap(), BTreeMap::from([("qq:1".to_string(), 10)]));
    }
}
