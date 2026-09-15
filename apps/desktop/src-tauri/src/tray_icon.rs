use tauri::{tray::TrayIcon, Runtime};

#[cfg(target_os = "macos")]
extern "C" {
    fn codexboard_install_menu_glyph(item: *mut std::ffi::c_void);
}

/// Use a native template plus a mint overlay; macOS owns foreground tinting.
pub fn install<R: Runtime>(tray: &TrayIcon<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    tray.with_inner_tray_icon(|inner| {
        if let Some(item) = inner.ns_status_item() {
            let pointer = (&*item as *const _) as *mut std::ffi::c_void;
            // Tauri runs this closure on the main thread; item owns the button/view.
            unsafe { codexboard_install_menu_glyph(pointer) };
        }
    })?;
    Ok(())
}
