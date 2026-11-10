// Release builds are GUI apps on Windows: no console window behind the main window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cip_desktop_lib::run();
}
