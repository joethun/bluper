use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

mod native_fs;

/// Which page the window should open on, when something other than the default
/// is asked for.
///
/// `BLUPER_SELFTEST=1` opens the desktop storage self-check, which runs on load
/// and prints each result to stdout — that's how the shell gets verified from a
/// terminal without driving the UI. `BLUPER_START_PATH` opens any other route,
/// which is useful for looking at one screen without clicking through to it.
fn startup_path() -> Option<String> {
    if selftest_enabled() {
        return Some("/desktop-check/?autorun=1".into());
    }

    std::env::var("BLUPER_START_PATH")
        .ok()
        .filter(|path| !path.is_empty())
}

/// Whether this process was launched to run the self-check and report it to a
/// terminal, rather than to be used. The self-check page is reachable by hand
/// either way, so this is what separates "print the results and leave" from "a
/// window someone is looking at".
pub fn selftest_enabled() -> bool {
    std::env::var("BLUPER_SELFTEST")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Longest a self-check may go without saying anything before the run is
/// declared stuck. Generous: the slowest check renders and encodes hundreds of
/// frames, and a machine under load is not a failure.
const SELFTEST_SILENCE_LIMIT: std::time::Duration = std::time::Duration::from_secs(90);

/// Ends a self-check run that has stopped reporting.
///
/// A check can take the webview's process down rather than throwing — a
/// WebCodecs encoder that aborts instead of rejecting is enough to do it — and
/// then the page is gone, no result is ever printed, and the shell sits there
/// with a window that has to be closed by hand, truncating the run. Nothing
/// inside the page can guard against its own process dying, so the shell holds
/// the deadline: no output for [`SELFTEST_SILENCE_LIMIT`] means exit non-zero and
/// say so, which is what a terminal or a CI job needs to hear.
fn spawn_selftest_watchdog<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let silent_for = native_fs::since_last_diagnostic();
            if silent_for >= SELFTEST_SILENCE_LIMIT {
                println!(
                    "[desktop-check] FAIL watchdog — nothing reported for {}s; the check that was \
                     running took the webview with it",
                    silent_for.as_secs()
                );
                app.exit(1);
                return;
            }
        }
    });
}

/// Reattaches stdout to the terminal that launched the app.
///
/// Release builds set `windows_subsystem = "windows"` so double-clicking the
/// exe doesn't flash a console, but that also detaches it from a console it was
/// launched *from*, which would send the self-check's output nowhere. Attaching
/// to the parent restores it. Redirecting to a file or a pipe already works
/// without this, because then the handle is inherited rather than absent.
///
/// Harmless when there is no parent console — the call just fails, which is the
/// double-click case. Must run before anything writes to stdout, since Rust
/// resolves the handle once, on first use.
#[cfg(windows)]
fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};

    // SAFETY: no pointer arguments; the only outcome is that the process gains
    // (or fails to gain) a console, and the return value is deliberately
    // ignored because failure is an expected, benign case.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    attach_parent_console();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(native_fs::WriteStreams::default())
        .invoke_handler(tauri::generate_handler![
            native_fs::bluper_media_path,
            native_fs::bluper_list_media,
            native_fs::bluper_remove_media,
            native_fs::bluper_clear_media,
            native_fs::bluper_media_size,
            native_fs::bluper_scratch_path,
            native_fs::bluper_open_write,
            native_fs::bluper_write_chunk,
            native_fs::bluper_close_write,
            native_fs::bluper_abort_write,
            native_fs::bluper_remove_file,
            native_fs::bluper_move_file,
            native_fs::bluper_available_disk_bytes,
            native_fs::bluper_diagnostic_log,
        ])
        .setup(|app| {
            native_fs::sweep_stale_scratch_files(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(debug_assertions)]
                window.open_devtools();

                // The window's icon has to be set at runtime — `tauri.conf.json`'s
                // window config has no `icon` field in Tauri 2.11 — and only the
                // PNG that matches the current GTK icon-size hint (typically
                // 32-48px on Linux, 16-24px on Windows) is worth shipping: the
                // compositor resamples anything bigger and the result looks
                // muddy. 32x32 is the overlap.
                if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/32x32.png"
                )) {
                    if let Err(error) = window.set_icon(icon) {
                        log::warn!("failed to set window icon: {error}");
                    }
                }

                if selftest_enabled() {
                    spawn_selftest_watchdog(app.handle().clone());
                }

                if let Some(path) = startup_path() {
                    // `eval` here would race the webview's initial navigation and
                    // be discarded; asking the window to navigate replaces it.
                    let base = window.url()?;
                    let url = base.join(&path)?;
                    println!("[desktop-check] navigating to {url}");
                    window.navigate(url)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
