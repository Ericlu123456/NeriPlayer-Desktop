use super::{
    github_config_store_value, webdav_config_store_value, ConfigGitHubSync, ConfigSyncPreferences,
    ConfigWebDavSync, DesktopConfigFile, CONFIG_FILE_KIND, CONFIG_FILE_VERSION,
};
use crate::auth::state::AuthState;
use crate::settings::store::AppSettings;
use crate::sync::models::{GitHubSyncConfig, SyncPreferencesConfig, WebDavSyncConfig};

#[test]
fn github_rate_limits_persist_a_cooldown_but_token_expiry_does_not() {
    use crate::error::AppError;
    use crate::sync::failure::SyncFailure;
    let now = 1_800_000_000_000;
    let limited = AppError::Sync(SyncFailure::GitHubRateLimited {
        status: 429,
        retry_at_ms: now + 30_000,
        automatic: true,
    });
    let (error, cooldown) = super::classify_github_sync_failure(limited, None, "owner/repo", now);
    let cooldown = cooldown.expect("a rate limit must persist a cooldown");
    assert_eq!(
        cooldown.retry_at_ms,
        now + 60_000,
        "the first backoff is one minute"
    );
    assert_eq!(
        error.to_string(),
        format!("GITHUB_RATE_LIMITED:{}:1", now + 60_000)
    );

    let (error, cooldown) = super::classify_github_sync_failure(
        AppError::Sync(SyncFailure::GitHubTokenExpired),
        Some(&cooldown),
        "owner/repo",
        now,
    );
    assert!(cooldown.is_none());
    assert_eq!(error.to_string(), "GITHUB_TOKEN_EXPIRED");
    assert_eq!(
        super::github_cooldown_target(&GitHubSyncConfig {
            owner: " Owner ".into(),
            repo: "Repo".into(),
            ..Default::default()
        }),
        "owner/repo"
    );
}

#[test]
fn upgrade_approval_requires_the_all_devices_confirmation() {
    assert!(super::ensure_all_devices_updated(false).is_err());
    assert!(super::ensure_all_devices_updated(true).is_ok());
}

#[test]
fn only_the_rejected_github_token_is_cleared() {
    let rejected = GitHubSyncConfig {
        token: "old".into(),
        owner: "owner".into(),
        repo: "repo".into(),
        auto_sync: true,
        ..Default::default()
    };
    let mut current = rejected.clone();
    assert!(super::clear_rejected_github_token(&mut current, &rejected));
    assert!(current.token.is_empty());
    assert_eq!(
        (current.owner.as_str(), current.repo.as_str()),
        ("owner", "repo")
    );
    assert!(!super::github_sync_configured(&current));

    let mut replaced = GitHubSyncConfig {
        token: "new".into(),
        ..rejected.clone()
    };
    assert!(!super::clear_rejected_github_token(
        &mut replaced,
        &rejected
    ));
    assert_eq!(
        replaced.token, "new",
        "a token replaced during the sync must survive"
    );
}

#[test]
fn validated_token_without_a_repository_is_not_a_configured_sync_target() {
    let mut config = GitHubSyncConfig::default();
    assert!(!super::github_sync_configured(&config));
    config.token = "fixture-token".into();
    config.owner = "owner".into();
    assert!(!super::github_sync_configured(&config));
    config.repo = "repo".into();
    assert!(super::github_sync_configured(&config));
    config.owner = " ".into();
    assert!(!super::github_sync_configured(&config));
}

#[test]
fn connection_preference_aba_preserves_last_user_choice() {
    let mut generations = super::ConfigRequestGenerations::default();
    let started = generations.github_preferences;
    let request = generations.begin(super::ConfigProvider::GitHub).unwrap();
    let mut current = GitHubSyncConfig {
        auto_sync: false,
        ..Default::default()
    };
    super::advance_preference_revision(&mut generations.github_preferences.auto_sync).unwrap();
    current.auto_sync = true;
    super::advance_preference_revision(&mut generations.github_preferences.auto_sync).unwrap();
    current.auto_sync = false;
    let proposed = GitHubSyncConfig {
        auto_sync: true,
        data_saver: true,
        ..Default::default()
    };
    let result = super::github_connection_preferences(
        started,
        generations.github_preferences,
        &current,
        proposed,
    );
    assert!(!result.auto_sync);
    generations.complete(request, || Ok(())).unwrap();
    let started = generations.webdav_preferences;
    let request = generations.begin(super::ConfigProvider::WebDav).unwrap();
    let mut current = WebDavSyncConfig {
        auto_sync: false,
        ..Default::default()
    };
    super::advance_preference_revision(&mut generations.webdav_preferences.auto_sync).unwrap();
    current.auto_sync = true;
    super::advance_preference_revision(&mut generations.webdav_preferences.auto_sync).unwrap();
    current.auto_sync = false;
    let proposed = WebDavSyncConfig {
        auto_sync: true,
        ..Default::default()
    };
    let result = super::webdav_connection_preferences(
        started,
        generations.webdav_preferences,
        &current,
        proposed,
    );
    assert!(!result.auto_sync);
    generations.complete(request, || Ok(())).unwrap();
}

#[test]
fn token_validation_clears_previous_target_only_when_identity_changes() {
    let original = GitHubSyncConfig {
        token: "old token".into(),
        owner: "old owner".into(),
        repo: "old repo".into(),
        last_remote_sha: "old sha".into(),
        last_sync_time: 42,
        auto_sync: true,
        data_saver: true,
        silent_failures: true,
        history_update_mode: "every_15_minutes".into(),
    };
    for (token, owner, changed) in [
        ("old token", "old owner", false),
        ("new token", "old owner", true),
        ("old token", "new owner", true),
    ] {
        let validated =
            super::validated_github_identity(original.clone(), token.into(), owner.into());
        assert_eq!(validated.token, token);
        assert_eq!(validated.owner, owner);
        assert_eq!(validated.repo, if changed { "" } else { "old repo" });
        assert_eq!(
            validated.last_remote_sha,
            if changed { "" } else { "old sha" }
        );
        assert_eq!(validated.last_sync_time, if changed { 0 } else { 42 });
        assert_eq!(validated.auto_sync, !changed);
        assert!(validated.data_saver);
        assert!(validated.silent_failures);
        assert_eq!(validated.history_update_mode, "every_15_minutes");
    }
}

#[test]
fn new_connection_defaults_are_preserved_without_preference_changes() {
    let started = GitHubSyncConfig::default();
    let proposed = GitHubSyncConfig {
        token: "new".into(),
        owner: "new".into(),
        repo: "new".into(),
        auto_sync: true,
        data_saver: true,
        ..Default::default()
    };
    let result = super::github_connection_preferences(
        super::GitHubPreferenceRevisions::default(),
        super::GitHubPreferenceRevisions::default(),
        &started,
        proposed,
    );
    assert!(result.auto_sync);
    assert!(result.data_saver);
    let started = WebDavSyncConfig::default();
    let proposed = WebDavSyncConfig {
        server_url: "https://new.invalid/".into(),
        auto_sync: true,
        ..Default::default()
    };
    let result = super::webdav_connection_preferences(
        super::WebDavPreferenceRevisions::default(),
        super::WebDavPreferenceRevisions::default(),
        &started,
        proposed,
    );
    assert!(result.auto_sync);
    assert!(!result.data_saver);
}

#[test]
fn connection_completion_preserves_changed_preferences_and_new_identity() {
    let started = GitHubSyncConfig {
        auto_sync: true,
        data_saver: true,
        history_update_mode: "immediate".into(),
        ..Default::default()
    };
    let current = GitHubSyncConfig {
        auto_sync: false,
        data_saver: false,
        silent_failures: true,
        history_update_mode: "every_15_minutes".into(),
        ..started.clone()
    };
    let proposed = GitHubSyncConfig {
        token: "new".into(),
        owner: "new owner".into(),
        repo: "new repo".into(),
        auto_sync: true,
        data_saver: true,
        ..Default::default()
    };
    let revisions = super::GitHubPreferenceRevisions {
        auto_sync: 1,
        data_saver: 1,
        silent_failures: 1,
        history_update_mode: 1,
    };
    let result = super::github_connection_preferences(
        super::GitHubPreferenceRevisions::default(),
        revisions,
        &current,
        proposed,
    );
    assert!(!result.auto_sync);
    assert!(!result.data_saver);
    assert!(result.silent_failures);
    assert_eq!(result.history_update_mode, "every_15_minutes");
    assert_eq!(result.token, "new");
    assert_eq!(result.owner, "new owner");
    assert_eq!(result.repo, "new repo");
    let started = WebDavSyncConfig {
        auto_sync: true,
        ..Default::default()
    };
    let current = WebDavSyncConfig {
        auto_sync: false,
        data_saver: true,
        ..started.clone()
    };
    let proposed = WebDavSyncConfig {
        server_url: "https://new.invalid/".into(),
        username: "new".into(),
        password: "new".into(),
        auto_sync: true,
        ..Default::default()
    };
    let revisions = super::WebDavPreferenceRevisions {
        auto_sync: 1,
        data_saver: 1,
    };
    let result = super::webdav_connection_preferences(
        super::WebDavPreferenceRevisions::default(),
        revisions,
        &current,
        proposed,
    );
    assert!(!result.auto_sync);
    assert!(result.data_saver);
    assert_eq!(result.server_url, "https://new.invalid/");
    assert_eq!(result.username, "new");
    assert_eq!(result.password, "new");
}

#[test]
fn config_requests_reverse_completion_rejects_old_save() {
    let mut generations = super::ConfigRequestGenerations::default();
    let old = generations.begin(super::ConfigProvider::GitHub).unwrap();
    let new = generations.begin(super::ConfigProvider::GitHub).unwrap();
    let mut stored = "initial";
    generations
        .complete(new, || {
            stored = "new";
            Ok(())
        })
        .unwrap();
    assert!(generations
        .complete(old, || {
            stored = "old";
            Ok(())
        })
        .is_err());
    assert_eq!(stored, "new");
}

#[test]
fn config_request_after_disconnect_cannot_restore_identity() {
    for provider in [super::ConfigProvider::GitHub, super::ConfigProvider::WebDav] {
        let mut generations = super::ConfigRequestGenerations::default();
        let pending = generations.begin(provider).unwrap();
        generations.invalidate(provider).unwrap();
        let mut stored = None;
        assert!(generations
            .complete(pending, || {
                stored = Some("old credential");
                Ok(())
            })
            .is_err());
        assert!(stored.is_none());
    }
}

#[test]
fn config_import_invalidates_both_and_preserves_newer_provider_intent() {
    let mut generations = super::ConfigRequestGenerations::default();
    let pending_github = generations.begin(super::ConfigProvider::GitHub).unwrap();
    let pending_webdav = generations.begin(super::ConfigProvider::WebDav).unwrap();
    let import_github = generations.begin(super::ConfigProvider::GitHub).unwrap();
    let import_webdav = generations.begin(super::ConfigProvider::WebDav).unwrap();
    let mut github = "old";
    let mut webdav = "old";
    assert!(generations
        .complete(pending_github, || {
            github = "pending";
            Ok(())
        })
        .is_err());
    assert!(generations
        .complete(pending_webdav, || {
            webdav = "pending";
            Ok(())
        })
        .is_err());
    let newer = generations.begin(super::ConfigProvider::GitHub).unwrap();
    generations
        .complete(newer, || {
            github = "newer";
            Ok(())
        })
        .unwrap();
    assert!(generations
        .complete(import_github, || {
            github = "imported";
            Ok(())
        })
        .is_err());
    generations
        .complete(import_webdav, || {
            webdav = "imported";
            Ok(())
        })
        .unwrap();
    assert_eq!(github, "newer");
    assert_eq!(webdav, "imported");
}

#[test]
fn config_providers_are_independent_and_preferences_do_not_invalidate_requests() {
    let mut generations = super::ConfigRequestGenerations::default();
    let github = generations.begin(super::ConfigProvider::GitHub).unwrap();
    let webdav = generations.begin(super::ConfigProvider::WebDav).unwrap();
    let github_read = generations.snapshot(super::ConfigProvider::GitHub);
    let webdav_read = generations.snapshot(super::ConfigProvider::WebDav);
    let auto_sync = false;
    super::advance_preference_revision(&mut generations.sync_preferences_revision).unwrap();
    assert_eq!(generations.sync_preferences_revision, 1);
    generations
        .complete(github, || {
            assert!(!auto_sync);
            Ok(())
        })
        .unwrap();
    generations
        .complete(webdav, || {
            assert!(!auto_sync);
            Ok(())
        })
        .unwrap();
    generations.complete(github_read, || Ok(())).unwrap();
    generations.complete(webdav_read, || Ok(())).unwrap();
}

#[test]
fn config_sync_and_upgrade_tickets_reject_disconnect_reconnect_aba() {
    for provider in [super::ConfigProvider::GitHub, super::ConfigProvider::WebDav] {
        let mut generations = super::ConfigRequestGenerations::default();
        let sync = generations.snapshot(provider);
        let upgrade = generations.snapshot(provider);
        generations.invalidate(provider).unwrap();
        let reconnect = generations.begin(provider).unwrap();
        let mut identity = "same target and credential";
        generations
            .complete(reconnect, || {
                identity = "same target and credential";
                Ok(())
            })
            .unwrap();
        assert_eq!(identity, "same target and credential");
        assert!(generations
            .complete(sync, || -> crate::error::AppResult<()> {
                panic!("ABA sync must not apply local data")
            })
            .is_err());
        assert!(generations
            .complete(upgrade, || -> crate::error::AppResult<()> {
                panic!("ABA upgrade must not authorize old target")
            })
            .is_err());
    }
}

#[test]
fn completion_preserves_preferences_changed_during_network_request() {
    let requested = GitHubSyncConfig {
        token: "fixture-token".into(),
        owner: "owner".into(),
        repo: "repo".into(),
        auto_sync: true,
        ..Default::default()
    };
    let mut current = requested.clone();
    current.auto_sync = false;
    current.data_saver = false;
    current.silent_failures = true;
    current.history_update_mode = "every_15_minutes".into();
    let result = super::complete_for_current_target(
        &mut current,
        &requested,
        super::same_github_target,
        || Ok(7),
        |current| {
            current.last_remote_sha = "completed".into();
            current.last_sync_time = 20;
        },
    )
    .unwrap();
    assert_eq!(result, 7);
    assert!(!current.auto_sync);
    assert!(!current.data_saver);
    assert!(current.silent_failures);
    assert_eq!(current.history_update_mode, "every_15_minutes");
    assert_eq!(current.last_remote_sha, "completed");
    assert_eq!(current.last_sync_time, 20);

    let requested = WebDavSyncConfig {
        server_url: "https://fixture.invalid/".into(),
        username: "fixture".into(),
        password: "fixture-password".into(),
        base_path: "backup".into(),
        auto_sync: true,
        ..Default::default()
    };
    let mut current = requested.clone();
    current.auto_sync = false;
    current.data_saver = false;
    super::complete_for_current_target(
        &mut current,
        &requested,
        super::same_webdav_target,
        || Ok(()),
        |current| {
            current.last_remote_fingerprint = "completed".into();
            current.last_sync_time = 20;
        },
    )
    .unwrap();
    assert!(!current.auto_sync);
    assert!(!current.data_saver);
    assert_eq!(current.last_remote_fingerprint, "completed");
    assert_eq!(current.last_sync_time, 20);
}

#[test]
fn changed_target_credentials_and_disconnect_reject_before_any_local_apply() {
    let requested = GitHubSyncConfig {
        token: "fixture-token".into(),
        owner: "owner".into(),
        repo: "repo".into(),
        ..Default::default()
    };
    for field in ["owner", "repo", "token", "disconnect"] {
        let mut current = requested.clone();
        match field {
            "owner" => current.owner = "different".into(),
            "repo" => current.repo = "different".into(),
            "token" => current.token = "different".into(),
            _ => current = GitHubSyncConfig::default(),
        }
        let before = super::github_config_store_value(&current);
        let result = super::complete_for_current_target(
            &mut current,
            &requested,
            super::same_github_target,
            || -> crate::error::AppResult<()> {
                panic!("stale completion must not apply local data")
            },
            |_| panic!("stale completion must not record progress"),
        );
        assert!(result.is_err(), "{field}");
        assert_eq!(super::github_config_store_value(&current), before);
        if field == "disconnect" {
            assert!(current.token.is_empty());
        }
    }
    let requested = WebDavSyncConfig {
        server_url: "https://fixture.invalid/".into(),
        username: "fixture".into(),
        password: "fixture-password".into(),
        base_path: "backup".into(),
        ..Default::default()
    };
    for field in ["server", "username", "password", "path", "disconnect"] {
        let mut current = requested.clone();
        match field {
            "server" => current.server_url = "https://different.invalid/".into(),
            "username" => current.username = "different".into(),
            "password" => current.password = "different".into(),
            "path" => current.base_path = "different".into(),
            _ => current = WebDavSyncConfig::default(),
        }
        let before = super::webdav_config_store_value(&current);
        let result = super::complete_for_current_target(
            &mut current,
            &requested,
            super::same_webdav_target,
            || -> crate::error::AppResult<()> {
                panic!("stale completion must not apply local data")
            },
            |_| panic!("stale completion must not record progress"),
        );
        assert!(result.is_err(), "{field}");
        assert_eq!(super::webdav_config_store_value(&current), before);
        if field == "disconnect" {
            assert!(current.password.is_empty());
        }
    }
}

#[test]
fn failed_local_apply_does_not_advance_sync_progress() {
    let requested = GitHubSyncConfig {
        token: "fixture-token".into(),
        owner: "owner".into(),
        repo: "repo".into(),
        last_sync_time: 10,
        ..Default::default()
    };
    let mut current = requested.clone();
    let result = super::complete_for_current_target(
        &mut current,
        &requested,
        super::same_github_target,
        || -> crate::error::AppResult<()> {
            Err(crate::error::AppError::Other(
                "fixture write failure".into(),
            ))
        },
        |_| panic!("failed local apply must not advance progress"),
    );
    assert!(result.is_err());
    assert_eq!(current.last_sync_time, 10);
}

#[test]
fn disconnect_serializes_with_completion_and_is_not_revived() {
    use std::sync::{mpsc, Arc};
    let requested = GitHubSyncConfig {
        token: "fixture-token".into(),
        owner: "owner".into(),
        repo: "repo".into(),
        ..Default::default()
    };
    let stored = Arc::new(parking_lot::Mutex::new(requested.clone()));
    let (entered, entered_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let completion_store = stored.clone();
    let completion = std::thread::spawn(move || {
        super::with_sync_config(|| {
            let mut current = completion_store.lock().clone();
            super::complete_for_current_target(
                &mut current,
                &requested,
                super::same_github_target,
                || {
                    entered.send(()).unwrap();
                    release_rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok(())
                },
                |current| current.last_sync_time = 20,
            )
            .unwrap();
            *completion_store.lock() = current;
        })
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let (started, started_rx) = mpsc::channel();
    let (done, done_rx) = mpsc::channel();
    let disconnect_store = stored.clone();
    let disconnect = std::thread::spawn(move || {
        started.send(()).unwrap();
        super::with_sync_config(|| *disconnect_store.lock() = GitHubSyncConfig::default());
        done.send(()).unwrap();
    });
    started_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    release.send(()).unwrap();
    completion.join().unwrap();
    disconnect.join().unwrap();
    let current = stored.lock();
    assert!(current.token.is_empty());
    assert!(current.owner.is_empty());
    assert_eq!(current.last_sync_time, 0);
}

#[test]
fn github_store_value_excludes_token() {
    let config = GitHubSyncConfig {
        token: "secret-token".into(),
        owner: "owner".into(),
        repo: "repo".into(),
        ..Default::default()
    };
    let value = github_config_store_value(&config);

    assert!(value.get("token").is_none());
    assert!(serde_json::to_value(&config)
        .unwrap()
        .get("token")
        .is_none());
    assert_eq!(value["owner"], "owner");
}

#[test]
fn webdav_store_value_excludes_password() {
    let config = WebDavSyncConfig {
        server_url: "https://dav.example.test".into(),
        username: "user".into(),
        password: "secret-password".into(),
        ..Default::default()
    };
    let value = webdav_config_store_value(&config);

    assert!(value.get("password").is_none());
    assert!(serde_json::to_value(&config)
        .unwrap()
        .get("password")
        .is_none());
    assert_eq!(value["serverUrl"], "https://dav.example.test");
}

#[test]
fn desktop_config_marks_pc_and_contains_sensitive_sections() {
    let value = serde_json::to_value(DesktopConfigFile {
        kind: CONFIG_FILE_KIND.into(),
        format_version: CONFIG_FILE_VERSION,
        platform: "pc".into(),
        platform_name: "NeriPlayer Desktop".into(),
        exported_at: 1,
        settings: AppSettings::default(),
        listen_together: Some(Default::default()),
        language: Some(Default::default()),
        auth: Some(AuthState::default()),
        github_sync: Some(ConfigGitHubSync {
            token: "token".into(),
            ..Default::default()
        }),
        webdav_sync: Some(ConfigWebDavSync {
            password: "password".into(),
            ..Default::default()
        }),
        sync_preferences: Some(ConfigSyncPreferences::default()),
    })
    .unwrap();

    assert_eq!(value["platform"], "pc");
    assert_eq!(value["platformName"], "NeriPlayer Desktop");
    assert_eq!(value["githubSync"]["token"], "token");
    assert_eq!(value["webdavSync"]["password"], "password");
}

#[test]
fn sync_preferences_store_value_uses_canonical_mode() {
    let value = super::sync_preferences_store_value(&SyncPreferencesConfig {
        history_update_mode: "EVERY_15_MINUTES".into(),
    });

    assert_eq!(value["historyUpdateMode"], "every_15_minutes");
}

#[test]
fn android_settings_apply_maps_known_keys_only() {
    use super::AndroidTypedSettings;
    let android = AndroidTypedSettings {
        booleans: [
            ("bypass_proxy".into(), true),
            ("usb_exclusive_playback".into(), true),
        ]
        .into_iter()
        .collect(),
        floats: [("lyric_font_scale".into(), 1.25)].into_iter().collect(),
        longs: [
            ("cloud_music_lyric_default_offset_ms".into(), 250),
            ("max_cache_size_bytes".into(), 10_737_418_240),
        ]
        .into_iter()
        .collect(),
        strings: [
            ("audio_quality".into(), "jymaster".into()),
            ("youtube_audio_quality".into(), "low".into()),
            ("theme_color_spec".into(), "SPEC_2025".into()),
        ]
        .into_iter()
        .collect(),
    };
    let mut settings = AppSettings::default();
    android.apply_to(&mut settings);

    assert!(settings.bypass_proxy);
    assert!((settings.lyric_font_scale - 1.25).abs() < f32::EPSILON);
    assert_eq!(settings.cloud_music_offset, 250);
    assert_eq!(settings.max_cache_size, 10_240);
    assert_eq!(settings.netease_quality, "jymaster");
    assert_eq!(settings.youtube_quality, "low");
    // 未知键与桌面无关键不产生副作用
    assert!(settings.dynamic_background);
    assert_eq!(settings.theme_color, "purple");
}

#[test]
fn android_dynamic_color_maps_to_system_mode() {
    use super::AndroidTypedSettings;
    let android = AndroidTypedSettings {
        booleans: [("dynamic_color".into(), true)].into_iter().collect(),
        floats: Default::default(),
        longs: Default::default(),
        strings: Default::default(),
    };
    let mut settings = AppSettings::default();
    android.apply_to(&mut settings);
    // Android 的 dynamic_color = Material You 跟随系统取色
    assert_eq!(settings.color_mode, "system");

    let android = AndroidTypedSettings {
        booleans: [("dynamic_color".into(), false)].into_iter().collect(),
        floats: Default::default(),
        longs: Default::default(),
        strings: Default::default(),
    };
    let mut settings = AppSettings::default();
    android.apply_to(&mut settings);
    assert_eq!(settings.color_mode, "default");
}

#[test]
fn android_config_file_parses_and_maps() {
    use super::{is_android_config, map_android_auth, AndroidConfigFile, ConfigListenTogether};
    let json = r#"{
            "kind": "moe.ouom.neriplayer.config",
            "formatVersion": 1,
            "exportedAt": 1787906559291,
            "settings": { "booleans": { "bypass_proxy": true }, "floats": {}, "ints": {}, "longs": {}, "strings": {} },
            "listenTogether": { "workerBaseUrl": "https://lt.example", "userUuid": "abc", "nickname": "me" },
            "language": { "code": "zh" },
            "neteaseAuth": { "cookies": { "MUSIC_U": "v1", "__csrf": "" }, "savedAt": 1 },
            "biliAuth": { "cookies": {}, "savedAt": 0 },
            "youTubeAuth": { "cookies": { "SAPISID": "s1" }, "authorization": "SAPISIDHASH x", "savedAt": 1 },
            "gitHubSync": { "token": "", "repoOwner": "", "repoName": "", "autoSyncEnabled": true, "playHistoryUpdateMode": "", "dataSaverMode": true },
            "webDavSync": { "serverUrl": "https://dav.example", "basePath": "", "username": "u", "password": "p", "autoSyncEnabled": true },
            "syncPreferences": { "playHistoryUpdateMode": "IMMEDIATE" }
        }"#;
    let root: serde_json::Value = serde_json::from_str(json).unwrap();
    assert!(is_android_config(&root));

    let config: AndroidConfigFile = serde_json::from_value(root).unwrap();
    assert_eq!(config.kind, CONFIG_FILE_KIND);
    assert_eq!(config.format_version, 1);
    assert_eq!(
        config.listen_together.as_ref().unwrap().worker_base_url,
        "https://lt.example"
    );
    assert_eq!(config.language.as_ref().unwrap().code, "zh");
    assert!(config
        .netease_auth
        .as_ref()
        .unwrap()
        .cookies
        .contains_key("MUSIC_U"));
    assert!(config.bili_auth.as_ref().unwrap().cookies.is_empty());
    assert!(config.git_hub_sync.is_some());
    assert_eq!(
        config.web_dav_sync.as_ref().unwrap().server_url,
        "https://dav.example"
    );

    let lt: ConfigListenTogether = config.listen_together.clone().unwrap().into();
    assert_eq!(lt.server_url, "https://lt.example");
    assert_eq!(lt.user_uuid, "abc");

    let auth = map_android_auth(&config).unwrap();
    assert!(auth.netease.is_some());
    assert!(auth.bilibili.is_none());
    assert!(auth.youtube.is_some());
    // 空值 Cookie 被过滤
    assert_eq!(auth.netease.as_ref().unwrap().cookies.len(), 1);
    assert_eq!(
        auth.netease.as_ref().unwrap().cookies[0].domain,
        "music.163.com"
    );
    // YouTube 会话 Cookie 要同时落在 youtube.com 与 google.com 上，播放和账号接口才都认
    let youtube = &auth.youtube.as_ref().unwrap().cookies;
    assert!(youtube
        .iter()
        .any(|c| c.name == "SAPISID" && c.domain == ".youtube.com"));
    assert!(youtube
        .iter()
        .any(|c| c.name == "SAPISID" && c.domain == ".google.com"));
}

#[test]
fn android_auth_merges_per_platform() {
    use super::merge_imported_auth;
    use crate::auth::state::{AuthState, BiliAuth, CookieEntry, NeteaseAuth};
    let cookie = |value: &str| CookieEntry {
        name: "SESSDATA".into(),
        value: value.into(),
        domain: ".bilibili.com".into(),
    };
    let previous = AuthState {
        netease: Some(NeteaseAuth {
            cookies: vec![],
            user_id: Some(1),
            nickname: None,
            avatar_url: None,
        }),
        bilibili: Some(BiliAuth {
            cookies: vec![cookie("old")],
            mid: None,
            nickname: None,
            avatar_url: None,
        }),
        youtube: None,
    };
    let imported = AuthState {
        netease: None,
        bilibili: Some(BiliAuth {
            cookies: vec![cookie("new")],
            mid: None,
            nickname: None,
            avatar_url: None,
        }),
        youtube: None,
    };
    let merged = merge_imported_auth(&previous, imported);
    // 备份里没有的平台保留原登录，有的平台用备份覆盖
    assert_eq!(merged.netease.unwrap().user_id, Some(1));
    assert_eq!(merged.bilibili.unwrap().cookies[0].value, "new");
    assert!(merged.youtube.is_none());
}

#[test]
fn android_empty_sections_do_not_clobber_existing_config() {
    use super::{
        map_android_auth, map_android_github, map_android_language, map_android_listen_together,
        map_android_sync_preferences, map_android_webdav, AndroidConfigFile,
    };
    let json = r#"{
            "kind": "moe.ouom.neriplayer.config",
            "formatVersion": 1,
            "settings": { "booleans": {}, "floats": {}, "ints": {}, "longs": {}, "strings": {} },
            "listenTogether": { "workerBaseUrl": "", "userUuid": "", "nickname": "" },
            "language": { "code": "" },
            "gitHubSync": { "token": "", "repoOwner": "", "repoName": "", "autoSyncEnabled": true, "playHistoryUpdateMode": "", "dataSaverMode": true },
            "webDavSync": { "serverUrl": "", "basePath": "", "username": "", "password": "", "autoSyncEnabled": true },
            "syncPreferences": { "playHistoryUpdateMode": "" }
        }"#;
    let config: AndroidConfigFile =
        serde_json::from_value(serde_json::from_str(json).unwrap()).unwrap();
    assert!(map_android_listen_together(config.listen_together.clone()).is_none());
    assert!(map_android_language(config.language.clone()).is_none());
    assert!(map_android_github(config.git_hub_sync.clone()).is_none());
    assert!(map_android_webdav(config.web_dav_sync.clone()).is_none());
    assert!(map_android_sync_preferences(config.sync_preferences.clone()).is_none());
    assert!(map_android_auth(&config).is_none());
}
