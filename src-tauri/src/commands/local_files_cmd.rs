use std::collections::HashMap;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, AppResult};
use crate::library::{playlist::PlaylistStore, scanner};
use crate::state::TrackInfo;

static SCANS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn scans() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ScanSession(String);

impl Drop for ScanSession {
    fn drop(&mut self) {
        scans().lock().unwrap_or_else(|error| error.into_inner()).remove(&self.0);
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalScanProgress {
    session_id: String,
    visited_entries: usize,
    tracks: usize,
    skipped: usize,
    current_path: String,
}

#[tauri::command]
pub async fn scan_local_files(
    app: AppHandle,
    session_id: String,
    dir: String,
    name_template: Option<String>,
) -> AppResult<scanner::ScanResult> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err(AppError::Other("Invalid scan session".into()));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = scans().lock().unwrap_or_else(|error| error.into_inner());
        if !active.is_empty() {
            return Err(AppError::Other("A local scan is already running".into()));
        }
        active.insert(session_id.clone(), cancelled.clone());
    }
    let session = ScanSession(session_id.clone());
    tokio::task::spawn_blocking(move || {
        let _session = session;
        scanner::scan_directory_with_control(&dir, name_template.as_deref(), &cancelled, |visited_entries, tracks, skipped, path| {
            let _ = app.emit("local-scan-progress", LocalScanProgress {
                session_id: session_id.clone(), visited_entries, tracks, skipped,
                current_path: path.display().to_string(),
            });
        })
    }).await.map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub fn cancel_local_scan(session_id: String) -> bool {
    if let Some(cancelled) = scans().lock().unwrap_or_else(|error| error.into_inner()).get(&session_id) {
        cancelled.store(true, Ordering::Release);
        return true;
    }
    false
}

#[tauri::command]
pub async fn get_local_playlist_tracks() -> AppResult<Vec<TrackInfo>> {
    tokio::task::spawn_blocking(|| {
        let mut path = dirs_next::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        path.push("NeriPlayer");
        path.push("playlists.json");
        let store = PlaylistStore::load_strict(&path)?;
        Ok(store.playlists.into_iter().flat_map(|playlist| playlist.tracks).collect())
    }).await.map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn edit_local_file_tags(app: AppHandle, scan_root: String, file_path: String, title: String, artist: String, album: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || {
        let root = std::path::Path::new(&scan_root);
        let audio = std::path::Path::new(&file_path);
        super::download_cmd::edit_download_metadata(&app, audio, &title, &artist, &album, || {
            crate::library::local_file_tags::edit_tags(root, audio, &title, &artist, &album)
        })
    }).await.map_err(|error| AppError::Other(error.to_string()))?
}
