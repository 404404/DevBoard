use crate::Controller;
use flate2::read::GzDecoder;
use serde::Serialize;
use std::{
    collections::HashSet,
    ffi::CString,
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    status: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    last_checked: Option<u64>,
    can_install: bool,
}

impl UpdateStatus {
    fn busy(&self) -> bool {
        matches!(
            self.status.as_str(),
            "checking" | "downloading" | "installing"
        )
    }
}

struct PendingUpdate {
    status: UpdateStatus,
    update: Option<Update>,
    // Only Update::download can populate this buffer, after its signature check.
    verified_bytes: Option<Arc<Vec<u8>>>,
}

pub struct Updates {
    pending: Mutex<PendingUpdate>,
    checked_file: PathBuf,
}

impl Updates {
    pub fn new(current_version: String, data: &Path) -> Self {
        let checked_file = data.join("updater-state.json");
        let last_checked = fs::read(&checked_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value["lastChecked"].as_u64());
        Self {
            pending: Mutex::new(PendingUpdate {
                status: UpdateStatus {
                    current_version,
                    status: "idle".into(),
                    version: None,
                    notes: None,
                    downloaded_bytes: 0,
                    total_bytes: None,
                    error: None,
                    last_checked,
                    can_install: false,
                },
                update: None,
                verified_bytes: None,
            }),
            checked_file,
        }
    }

    fn status(&self) -> UpdateStatus {
        self.pending.lock().unwrap().status.clone()
    }

    fn fail(&self, message: impl Into<String>) {
        let mut pending = self.pending.lock().unwrap();
        pending.status.status = "error".into();
        pending.status.error = Some(message.into());
        pending.status.can_install = pending.verified_bytes.is_some();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn checked_recently(last: Option<u64>, now: u64) -> bool {
    last.is_some_and(|last| now >= last && now - last < DAY_MS)
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> UpdateStatus {
    app.state::<Updates>().status()
}

#[tauri::command]
pub fn check_updates(
    app: tauri::AppHandle,
    automatic: Option<bool>,
) -> Result<UpdateStatus, String> {
    if app.state::<Controller>().quitting.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    let state = app.state::<Updates>();
    let mut pending = state.pending.lock().unwrap();
    let now = now_ms();
    if pending.status.busy()
        || pending.status.can_install
        || (automatic.unwrap_or(false) && checked_recently(pending.status.last_checked, now))
    {
        return Ok(pending.status.clone());
    }
    pending.update = None;
    pending.verified_bytes = None;
    pending.status.status = "checking".into();
    pending.status.version = None;
    pending.status.notes = None;
    pending.status.error = None;
    pending.status.downloaded_bytes = 0;
    pending.status.total_bytes = None;
    pending.status.last_checked = Some(now);
    // Persist attempts too, so a failing endpoint is not retried on every launch.
    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&state.checked_file)
    {
        let _ = writeln!(file, "{{\"lastChecked\":{now}}}");
    }
    let status = pending.status.clone();
    drop(pending);
    tauri::async_runtime::spawn(async move {
        let result = async {
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(30))
                .build()?;
            // The official comparator only accepts newer versions; no downgrade override.
            updater.check().await
        }
        .await;
        let state = app.state::<Updates>();
        match result {
            Ok(Some(mut update)) => {
                if update.download_url.scheme() != "https" {
                    state.fail("更新包地址必须使用 HTTPS。");
                    return;
                }
                update.timeout = Some(Duration::from_secs(15 * 60));
                let mut pending = state.pending.lock().unwrap();
                pending.status.status = "available".into();
                pending.status.version = Some(update.version.clone());
                pending.status.notes = update.body.clone();
                pending.update = Some(update);
            }
            Ok(None) => state.pending.lock().unwrap().status.status = "upToDate".into(),
            Err(_) => state.fail("检查更新失败，请检查网络连接或稍后重试。"),
        }
    });
    Ok(status)
}

#[tauri::command]
pub fn download_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    if app.state::<Controller>().quitting.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    let state = app.state::<Updates>();
    let mut pending = state.pending.lock().unwrap();
    if pending.status.busy() || pending.status.can_install {
        return Ok(pending.status.clone());
    }
    let update = pending.update.clone().ok_or("请先检查更新")?;
    pending.status.status = "downloading".into();
    pending.status.error = None;
    pending.status.downloaded_bytes = 0;
    pending.status.total_bytes = None;
    let status = pending.status.clone();
    drop(pending);
    tauri::async_runtime::spawn(async move {
        let result = update
            .download(
                |length, total| {
                    let state = app.state::<Updates>();
                    let mut pending = state.pending.lock().unwrap();
                    pending.status.downloaded_bytes += length as u64;
                    pending.status.total_bytes = total;
                },
                || {},
            )
            .await;
        let state = app.state::<Updates>();
        match result {
            Ok(bytes) => {
                if validate_archive(&bytes).is_err() {
                    state.fail("更新包结构不完整或不安全，请重新下载或使用发布页的 DMG。");
                    return;
                }
                let mut pending = state.pending.lock().unwrap();
                pending.status.downloaded_bytes = bytes.len() as u64;
                pending.status.can_install = true;
                pending.verified_bytes = Some(Arc::new(bytes));
                pending.status.status = "ready".into();
            }
            Err(_) => state.fail("下载或签名验证失败，未安装更新。请检查网络后重新下载。"),
        }
    });
    Ok(status)
}

#[tauri::command]
pub fn install_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let state = app.state::<Updates>();
    let mut pending = state.pending.lock().unwrap();
    if pending.status.busy() {
        return Ok(pending.status.clone());
    }
    let update = pending.update.clone().ok_or("请先下载更新")?;
    let bytes = pending.verified_bytes.clone().ok_or("请先下载并验证更新")?;
    let controller = app.state::<Controller>();
    // The stdin lock orders this reservation after any already accepted control command.
    let input = controller.input.lock().unwrap();
    if controller.quitting.load(Ordering::SeqCst)
        || controller.installing.swap(true, Ordering::SeqCst)
    {
        return Err("应用正在退出或安装更新".into());
    }
    drop(input);
    pending.status.status = "installing".into();
    pending.status.error = None;
    let status = pending.status.clone();
    drop(pending);
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(message) = install_and_restart(&app, &update, &bytes) {
            app.state::<Updates>().fail(message);
            app.state::<Controller>()
                .installing
                .store(false, Ordering::SeqCst);
        }
    });
    Ok(status)
}

fn installed_bundle(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let executable = tauri::process::current_binary(&app.env())
        .map_err(|_| "无法定位已安装的应用，请使用 DMG 安装到 Applications 后重试")?;
    let macos = executable.parent().ok_or("应用路径无效")?;
    let contents = macos.parent().ok_or("应用路径无效")?;
    let bundle = contents.parent().ok_or("应用路径无效")?;
    if macos.file_name().is_none_or(|name| name != "MacOS")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || bundle
            .extension()
            .is_none_or(|extension| extension != "app")
    {
        return Err("请从完整安装的 .app 检查和安装更新".into());
    }
    for path in [bundle, bundle.parent().ok_or("应用路径无效")?] {
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| "应用路径无效")?;
        if unsafe { libc::access(path.as_ptr(), libc::W_OK) } != 0 {
            return Err(
                "应用所在位置不可写，请退出磁盘映像，并使用 DMG 安装到可写位置后重试。".into(),
            );
        }
    }
    Ok((bundle.to_path_buf(), executable))
}

fn install_and_restart(
    app: &tauri::AppHandle,
    update: &Update,
    verified_bytes: &[u8],
) -> Result<(), String> {
    let (bundle, executable) = installed_bundle(app)?;
    let controller = app.state::<Controller>();
    controller.stop_for_update()?;
    // install() receives exactly the in-memory bytes verified by official download().
    // The plugin owns replacement staging. It does not promise rollback for every
    // macOS filesystem error, so never exit on an installation error.
    update.install(verified_bytes).map_err(|_| {
        "自动安装未完成，应用未退出。请重试；若应用无法重新打开，请用 DMG 重新安装，现有配置和数据保留。"
            .to_string()
    })?;
    let valid = executable.is_file()
        && bundle.join("Contents/Resources/runtime/bin/node").is_file()
        && Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(&bundle)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
    if !valid {
        return Err("更新后的应用校验未通过，当前应用未退出。请使用发布页的 DMG 重新安装。".into());
    }
    controller.drain_for_update()?;
    // The new process waits for our instance lock. Only quit after spawn succeeds.
    Command::new(&executable)
        .arg("--lark-codex-updated")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "更新已安装，但无法自动重新启动。请退出并重新打开 Lark-Codex。")?;
    controller.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

// The macOS plugin strips the first archive component. Validate that this is one
// complete app, and reject paths or links that could escape that app directory.
fn validate_archive(bytes: &[u8]) -> Result<(), ()> {
    let mut archive = tar::Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let mut root: Option<PathBuf> = None;
    let mut files = HashSet::new();
    let mut entries = HashSet::new();
    for entry in archive.entries().map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        let path = entry.path().map_err(|_| ())?;
        let mut components = path.components();
        let first = match components.next() {
            Some(Component::Normal(first))
                if Path::new(first).extension().is_some_and(|x| x == "app") =>
            {
                PathBuf::from(first)
            }
            _ => return Err(()),
        };
        if root.as_ref().is_some_and(|root| root != &first) {
            return Err(());
        }
        root = Some(first);
        if components.any(|component| !matches!(component, Component::Normal(_))) {
            return Err(());
        }
        let relative: PathBuf = path.components().skip(1).collect();
        if !entries.insert(relative.clone()) {
            return Err(());
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            let link = entry.link_name().map_err(|_| ())?.ok_or(())?;
            let base = if kind.is_hard_link() {
                Path::new("")
            } else {
                path.parent().ok_or(())?
            };
            let mut depth = base.components().count() as isize;
            for component in link.components() {
                match component {
                    Component::Normal(_) => depth += 1,
                    Component::CurDir => {}
                    Component::ParentDir => {
                        depth -= 1;
                        if depth < 1 {
                            return Err(());
                        }
                    }
                    _ => return Err(()),
                }
            }
            if depth < 1 {
                return Err(());
            }
        } else if kind.is_file() {
            files.insert(relative.clone());
            if relative == Path::new("Contents/MacOS/lark-codex-desktop")
                && entry.header().mode().map_err(|_| ())? & 0o111 == 0
            {
                return Err(());
            }
        } else if !kind.is_dir() {
            return Err(());
        }
    }
    for required in [
        "Contents/Info.plist",
        "Contents/MacOS/lark-codex-desktop",
        "Contents/Resources/runtime/bin/node",
        "Contents/Resources/runtime/desktop/runtime.mjs",
    ] {
        if !files.contains(Path::new(required)) {
            return Err(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};

    fn archive(paths: &[&str]) -> Vec<u8> {
        let mut archive = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for path in paths {
            let mut header = tar::Header::new_gnu();
            header.set_size(1);
            header.set_mode(0o755);
            header.set_cksum();
            archive
                .append_data(&mut header, path, Cursor::new(b"x"))
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn automatic_attempts_are_throttled_but_clock_rollback_does_not_disable_checks() {
        assert!(checked_recently(Some(1000), 1000 + DAY_MS - 1));
        assert!(!checked_recently(Some(1000), 1000 + DAY_MS));
        assert!(!checked_recently(Some(1000), 999));
        assert!(!checked_recently(None, 1000));
    }

    #[test]
    fn requires_one_complete_application_archive() {
        let required = [
            "Lark-Codex.app/Contents/Info.plist",
            "Lark-Codex.app/Contents/MacOS/lark-codex-desktop",
            "Lark-Codex.app/Contents/Resources/runtime/bin/node",
            "Lark-Codex.app/Contents/Resources/runtime/desktop/runtime.mjs",
        ];
        assert!(validate_archive(&archive(&required)).is_ok());
        // The regular forwarding executable keeps already-published updaters
        // compatible while this version requires the renamed main executable.
        let mut compatible = required.to_vec();
        compatible.push("Lark-Codex.app/Contents/MacOS/taskboard-desktop");
        assert!(validate_archive(&archive(&compatible)).is_ok());
        assert!(validate_archive(&archive(&required[..3])).is_err());
        let mut mixed = required.to_vec();
        mixed.push("Another.app/Contents/unexpected");
        assert!(validate_archive(&archive(&mixed)).is_err());
        assert!(validate_archive(b"invalid archive").is_err());
        let mut duplicate = required.to_vec();
        duplicate.push(required[0]);
        assert!(validate_archive(&archive(&duplicate)).is_err());
    }

    #[test]
    fn rejects_links_that_escape_the_signed_application_root() {
        fn linked_archive(target: &str) -> Vec<u8> {
            let complete = archive(&[
                "Lark-Codex.app/Contents/Info.plist",
                "Lark-Codex.app/Contents/MacOS/lark-codex-desktop",
                "Lark-Codex.app/Contents/Resources/runtime/bin/node",
                "Lark-Codex.app/Contents/Resources/runtime/desktop/runtime.mjs",
            ]);
            let mut source = tar::Archive::new(GzDecoder::new(Cursor::new(complete)));
            let mut result = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
            for entry in source.entries().unwrap() {
                let mut entry = entry.unwrap();
                let header = entry.header().clone();
                result.append(&header, &mut entry).unwrap();
            }
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_mode(0o777);
            header.set_size(0);
            result
                .append_link(&mut header, "Lark-Codex.app/Contents/link", target)
                .unwrap();
            result.into_inner().unwrap().finish().unwrap()
        }
        assert!(validate_archive(&linked_archive("MacOS")).is_ok());
        assert!(validate_archive(&linked_archive("../../outside")).is_err());
        assert!(validate_archive(&linked_archive("/tmp/outside")).is_err());
    }

    #[test]
    #[ignore = "Requires the release tar.gz supplied in LARK_CODEX_UPDATE_ARCHIVE"]
    fn packaged_update_archive_matches_native_structure_check() {
        let path = std::env::var_os("LARK_CODEX_UPDATE_ARCHIVE")
            .expect("LARK_CODEX_UPDATE_ARCHIVE must point to the release tar.gz");
        let bytes = fs::read(path).expect("release archive must be readable");
        assert!(
            validate_archive(&bytes).is_ok(),
            "release archive was rejected by the native installer"
        );
    }
}
