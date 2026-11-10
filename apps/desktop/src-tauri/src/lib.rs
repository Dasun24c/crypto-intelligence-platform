//! Tauri host for the shared React app (architecture §13, ADR 008). The app itself lives in
//! `packages/app`; this crate adds only what a browser cannot: the OS keychain for the refresh token,
//! a tray icon, native notifications, opening links in the default browser and window state.

mod secure_store;
mod tray;

/// Builds and runs the desktop app until the user quits.
///
/// # Panics
///
/// Panics if Tauri cannot start (no WebView runtime, for example): there is nothing to fall back to.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            tray::create(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secure_store::secure_store_get,
            secure_store::secure_store_set,
            secure_store::secure_store_delete,
            tray::set_tray_status,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Crypto Intelligence Platform desktop app");
}
