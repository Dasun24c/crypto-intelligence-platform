//! Settings the desktop app keeps for itself, outside the webview: today, the server address.
//!
//! The address used to live in the webview's local storage. When the app was stopped by force, the
//! webview's storage came back without its newest writes, and the app forgot its server (found in
//! the Phase 8 desktop checklist run). It now lives in `settings.json` in the app's config folder,
//! written atomically: a temporary file, flushed to disk, then renamed over the old one.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Url};

const FILE_NAME: &str = "settings.json";

/// Plain-HTTP hosts that development builds accept, for a server running on this machine. The
/// webview applies the same rule (`platform.ts`); this module checks again before saving.
const DEV_HTTP_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    server_url: Option<String>,
}

/// The saved server address, or `None` when none is saved. A missing or damaged file, or an
/// address saved under other rules (by a development build, say), counts as none: the app asks again.
#[tauri::command]
pub async fn settings_get_server_url<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    blocking(move || {
        Ok(read(&path)?
            .server_url
            .and_then(|url| origin(&url, cfg!(debug_assertions)).ok()))
    })
    .await
}

/// Saves the server address, reduced to its origin.
#[tauri::command]
pub async fn settings_set_server_url<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let origin = origin(&url, cfg!(debug_assertions))?;
    let path = settings_path(&app)?;
    blocking(move || {
        let mut settings = read(&path)?;
        settings.server_url = Some(origin);
        write_atomically(&path, &settings)
    })
    .await
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|_| "the app's settings folder is not available".to_owned())
}

/// File access runs on a blocking thread, off the async runtime.
async fn blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "the settings task stopped unexpectedly".to_owned())?
}

/// Checks a server address and reduces it to its origin, e.g. `https://cip.example.org`. Only
/// HTTPS is accepted, apart from plain HTTP to this machine when `allow_dev_http` is set.
fn origin(input: &str, allow_dev_http: bool) -> Result<String, String> {
    let url = Url::parse(input.trim()).map_err(|_| "the server address is not a URL".to_owned())?;
    let dev_http = allow_dev_http
        && url.scheme() == "http"
        && url.host_str().is_some_and(|host| DEV_HTTP_HOSTS.contains(&host));
    if url.scheme() != "https" && !dev_http {
        return Err("the server address must start with https://".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the server address must not contain a user name or password".to_owned());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("the server address must not have a path".to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

/// Reads the settings. A missing file is empty settings; so is a damaged one, since nothing in it
/// can be trusted. Any other error (no permission, say) is reported.
fn read(path: &Path) -> Result<Settings, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(format!("the app's settings could not be read: {}", error.kind())),
    }
}

/// Replaces the settings file so that it holds either the old settings or the new, never a mix:
/// the new settings go to a temporary file, which is flushed to disk and then renamed over the old.
fn write_atomically(path: &Path, settings: &Settings) -> Result<(), String> {
    let failed = |error: io::Error| format!("the app's settings could not be saved: {}", error.kind());
    let dir = path
        .parent()
        .ok_or_else(|| "the app's settings folder is not available".to_owned())?;
    fs::create_dir_all(dir).map_err(failed)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|_| "the app's settings could not be saved".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary).map_err(failed)?;
    file.write_all(&bytes).map_err(failed)?;
    file.sync_all().map_err(failed)?;
    drop(file);
    fs::rename(&temporary, path).map_err(failed)?;
    // On Unix the rename itself is made durable by flushing the folder; Windows has no equivalent.
    #[cfg(unix)]
    fs::File::open(dir)
        .and_then(|folder| folder.sync_all())
        .map_err(failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{origin, read, write_atomically, Settings};
    use std::fs;
    use std::path::PathBuf;

    /// A fresh folder under the system temp directory, removed when dropped.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cip-desktop-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn saved(url: &str) -> Settings {
        Settings {
            server_url: Some(url.to_owned()),
        }
    }

    #[test]
    fn reduces_an_https_address_to_its_origin() {
        for (input, expected) in [
            ("https://cip.example.org", "https://cip.example.org"),
            ("  https://cip.example.org/  ", "https://cip.example.org"),
            ("https://localhost:8443", "https://localhost:8443"),
            ("https://CIP.Example.org:443/", "https://cip.example.org"),
        ] {
            assert_eq!(origin(input, false).as_deref(), Ok(expected), "{input}");
        }
    }

    #[test]
    fn refuses_anything_but_a_bare_https_origin() {
        for input in [
            "",
            "cip.example.org",
            "http://cip.example.org",
            "http://localhost:8080",
            "ftp://cip.example.org",
            "file:///C:/cip",
            "https://user:secret@cip.example.org",
            "https://user@cip.example.org",
            "https://cip.example.org/app",
            "https://cip.example.org/?a=1",
            "https://cip.example.org/#top",
        ] {
            assert!(origin(input, false).is_err(), "{input} was accepted");
        }
    }

    #[test]
    fn development_builds_also_accept_plain_http_to_this_machine() {
        assert_eq!(
            origin("http://localhost:8080", true).as_deref(),
            Ok("http://localhost:8080")
        );
        assert_eq!(
            origin("http://127.0.0.1:8080/", true).as_deref(),
            Ok("http://127.0.0.1:8080")
        );
        assert!(origin("http://cip.example.org", true).is_err());
        assert!(origin("http://localhost.example.org", true).is_err());
    }

    #[test]
    fn errors_never_repeat_the_address() {
        let error = origin("https://user:secret@cip.example.org", false).unwrap_err();
        assert!(!error.contains("secret"));
    }

    #[test]
    fn a_missing_or_damaged_file_is_empty_settings() {
        let dir = TempDir::new("missing");
        let path = dir.0.join("settings.json");
        assert_eq!(read(&path), Ok(Settings::default()));
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(read(&path), Ok(Settings::default()));
    }

    #[test]
    fn saves_and_replaces_atomically() {
        let dir = TempDir::new("save");
        let path = dir.0.join("settings.json");
        write_atomically(&path, &saved("https://one.example.org")).unwrap();
        assert_eq!(read(&path), Ok(saved("https://one.example.org")));
        write_atomically(&path, &saved("https://two.example.org")).unwrap();
        assert_eq!(read(&path), Ok(saved("https://two.example.org")));
        assert!(!path.with_extension("json.tmp").exists());
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains(r#""serverUrl": "https://two.example.org""#), "{text}");
    }
}
