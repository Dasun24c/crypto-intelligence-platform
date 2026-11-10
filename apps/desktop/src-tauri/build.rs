fn main() {
    // Listing the app's commands makes tauri-build generate an `allow-<command>` permission for each,
    // and makes Tauri check them: a command is then callable only where a capability grants it.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "secure_store_get",
        "secure_store_set",
        "secure_store_delete",
        "set_tray_status",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
