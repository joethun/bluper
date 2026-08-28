use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::webview::PageLoadEvent;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

pub mod media_audio;
pub mod media_decode;
pub mod media_frames;
pub mod media_readers;
mod mp4_export;
mod native_fs;

use mp4_export::Mp4Exports;

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

/// A snippet to run in the page once it has finished loading, from
/// `BLUPER_EVAL`.
///
/// The other half of `BLUPER_START_PATH`: the path opens a screen and this
/// drives it — seed a project, open a panel, select a clip — so a screenshot
/// can be taken of a state that would otherwise take a dozen clicks to reach.
/// It runs inside the real shell, against the real filesystem media store and
/// the real `asset:` pipeline, which is the whole point: there is no browser
/// build left to look at the UI in, and a tab could not show media anyway.
///
/// See `script/capture-window`, which is what usually sets this.
fn eval_script() -> Option<String> {
    std::env::var("BLUPER_EVAL")
        .ok()
        .filter(|script| !script.is_empty())
}

/// Where [`startup_path`] resolved to, recorded when the window was asked to go
/// there. `None` means it was left on the page it opened on.
///
/// [`eval_script`] waits for *this* page rather than the first one to finish,
/// because navigating produces a second load and the snippet is written against
/// the destination.
static STARTUP_URL: OnceLock<Option<tauri::Url>> = OnceLock::new();

/// Guards [`eval_script`] against running twice. A page that navigates within
/// itself — which the editor does — would otherwise re-run the snippet.
static EVAL_HAS_RUN: AtomicBool = AtomicBool::new(false);

/// Runs the `BLUPER_EVAL` snippet if this is the page it was meant for.
fn run_eval_on_load<R: tauri::Runtime>(webview: &tauri::Webview<R>, url: &tauri::Url) {
    let Some(script) = eval_script() else {
        return;
    };

    // `get()` rather than `wait()`: the load can finish before `setup` has
    // recorded anything, and a startup path that was never set is simply the
    // "run on the first page" case.
    if let Some(Some(expected)) = STARTUP_URL.get() {
        if url != expected {
            return;
        }
    }

    if EVAL_HAS_RUN.swap(true, Ordering::SeqCst) {
        return;
    }

    println!("[bluper] running BLUPER_EVAL on {url}");
    if let Err(error) = webview.eval(script) {
        println!("[bluper] BLUPER_EVAL failed: {error}");
    }
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
        .manage(media_decode::DecodeCache::default())
        // Open containers kept between requests, so the demux the webview
        // blocks on at every GOP boundary is a seek rather than a header parse.
        .manage(media_decode::VideoReaders::default())
        // Single frames decoded in Rust, which is what a seek and a scrub use.
        .manage(media_frames::frame_readers())
        .manage(media_audio::WaveformReaders::default())
        // Playback reads audio a window at a time off these rather than waiting
        // for the whole track to be decoded to disk first.
        .manage(media_audio::PcmWindowReaders::default())
        .manage(media_audio::PcmCache::default())
        .manage(Mp4Exports::default())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                run_eval_on_load(webview, payload.url());
            }
        })
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
            media_decode::bluper_decode_video_gop,
            media_decode::bluper_probe_media,
            media_decode::bluper_media_thumbnail,
            media_decode::bluper_clear_decode_cache,
            media_frames::bluper_decode_video_frame,
            media_audio::bluper_audio_waveform_segment,
            media_audio::bluper_audio_shape,
            media_audio::bluper_decode_audio_window,
            media_audio::bluper_decode_audio_pcm,
            media_audio::bluper_release_audio_pcm,
            mp4_export::bluper_export_capabilities,
            mp4_export::bluper_export_start,
            mp4_export::bluper_export_write_frame,
            mp4_export::bluper_export_write_audio,
            mp4_export::bluper_export_finish,
            mp4_export::bluper_export_cancel,
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

                let mut startup_url = None;
                if let Some(path) = startup_path() {
                    // `eval` here would race the webview's initial navigation and
                    // be discarded; asking the window to navigate replaces it,
                    // and `on_page_load` picks the snippet up when it lands.
                    let base = window.url()?;
                    let url = base.join(&path)?;
                    println!("[desktop-check] navigating to {url}");
                    window.navigate(url.clone())?;
                    startup_url = Some(url);
                }
                let _ = STARTUP_URL.set(startup_url);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
