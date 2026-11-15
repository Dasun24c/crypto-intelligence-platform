//! The tray icon: the connection status in its tooltip, and a menu to show the window or quit.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

const TRAY_ID: &str = "main";
const MAIN_WINDOW: &str = "main";
const PRODUCT_NAME: &str = "Crypto Intelligence Platform";
/// Windows cuts tray tooltips at 127 characters; the product name and a status this long fit.
const MAX_STATUS_CHARS: usize = 80;

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(PRODUCT_NAME)
        .menu(&menu)
        // Each platform's convention: macOS opens the menu on a left click, while Windows brings
        // the window back and keeps the menu on the right button.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let left_click = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            );
            if left_click && !cfg!(target_os = "macos") {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Puts the connection status after the product name in the tray tooltip, e.g. "Crypto
/// Intelligence Platform – Reconnecting". An empty status leaves the product name alone.
#[tauri::command]
pub fn set_tray_status<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or("the tray icon is not available")?;
    tray.set_tooltip(Some(tooltip(&text)))
        .map_err(|error| error.to_string())
}

fn tooltip(status: &str) -> String {
    let status: String = status
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_STATUS_CHARS)
        .collect();
    let status = status.trim();
    if status.is_empty() {
        PRODUCT_NAME.to_owned()
    } else {
        format!("{PRODUCT_NAME} – {status}")
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // Best effort: if any step fails the window simply stays where it was.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{tooltip, MAX_STATUS_CHARS, PRODUCT_NAME};

    #[test]
    fn tooltip_appends_the_status_to_the_product_name() {
        assert_eq!(tooltip("Online"), format!("{PRODUCT_NAME} – Online"));
        assert_eq!(tooltip("  \n "), PRODUCT_NAME);
    }

    #[test]
    fn tooltip_drops_control_characters_and_caps_the_status() {
        assert_eq!(tooltip("Off\nline"), format!("{PRODUCT_NAME} – Offline"));
        let long = tooltip(&"x".repeat(500));
        assert_eq!(
            long.chars().count(),
            PRODUCT_NAME.chars().count() + " – ".chars().count() + MAX_STATUS_CHARS
        );
    }
}
