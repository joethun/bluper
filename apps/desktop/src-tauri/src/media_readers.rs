//! Open containers kept between calls.
//!
//! Every media command here used to begin with `ffmpeg::format::input(path)`.
//! That call parses the container header and builds the seek index, and on real
//! media it is not a rounding error: measured against the user's own files it
//! costs 11ms for a 7MB clip, 16ms for a 1.2GB MP4 and 44ms for a 2.3GB one —
//! while the work the call was made *for*, seeking and walking one GOP, is
//! 0.3ms to 8ms. Reopening per request therefore spent between 65% and 99% of
//! its time re-reading a header that had not changed.
//!
//! That cost lands exactly where it is most visible. The webview asks for the
//! next GOP at each GOP boundary during playback and at every jump while
//! scrubbing, and each ask blocked on a fresh open. Keeping the context between
//! calls turns a 38ms request into a 0.3ms one on the same file.
//!
//! ## Why a pool rather than one context
//!
//! A project has several sources on the timeline and the playhead crosses
//! between them, so a single slot would thrash. The pool holds a handful and
//! evicts the least recently used, which is enough for the clips around the
//! playhead. Each entry is behind its own lock, so two files are read
//! concurrently and two requests for the *same* file queue — which is what
//! sharing one seek position requires anyway.
//!
//! ## Why the file's identity is in the key
//!
//! A context caches the header it parsed. If the file at that path is replaced
//! — an export overwriting its own source, a media file re-imported — a
//! retained context would answer from the old header and hand back packets at
//! offsets that no longer exist. Size and modification time are in the key, so
//! a replaced file is a miss rather than a stale hit.

use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use ffmpeg_next as ffmpeg;

/// How many open containers to keep. Each is a file descriptor and the
/// container's index, so this is cheap to hold; the number just needs to cover
/// the clips around the playhead rather than a whole project.
const DEFAULT_CAPACITY: usize = 6;

/// Initialises ffmpeg once per process, and quiets it.
///
/// `init` was previously called by the probe and thumbnail commands and not by
/// the decode path at all, which worked only because the registration it does
/// is a no-op in modern ffmpeg. Doing it once here removes the difference.
///
/// The log level matters more than it looks: libavformat writes to stderr on
/// every open, and on a container it dislikes it writes a paragraph. Errors
/// still come through — those are worth having in the log — but the per-open
/// chatter is not, and it was being paid on the playback hot path.
pub fn ensure_ffmpeg() -> Result<(), String> {
	static READY: OnceLock<Result<(), String>> = OnceLock::new();
	READY
		.get_or_init(|| {
			ffmpeg::init().map_err(|error| format!("initialising ffmpeg: {error}"))?;
			// SAFETY: sets a global integer in libavutil. No pointers, and the
			// `OnceLock` means it happens once, before any other ffmpeg call in
			// this process.
			unsafe {
				ffmpeg::ffi::av_log_set_level(ffmpeg::ffi::AV_LOG_ERROR);
			}
			Ok(())
		})
		.clone()
}

/// Which file, which version of it, and in what shape a pooled reader was
/// opened.
///
/// Length and modification time rather than a content hash: hashing gigabytes
/// to decide whether to reuse a context would cost more than reopening it.
///
/// `variant` names what the reader was built to produce, for pools whose
/// readers are not interchangeable — an audio reader resamples to one specific
/// rate and channel count, so one built for 48kHz stereo cannot answer a
/// request for 44.1kHz mono. Pools whose readers carry no such setting pass an
/// empty string.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
	path: PathBuf,
	variant: String,
	len: u64,
	modified_nanos: u128,
}

fn identity(path: &Path, variant: &str) -> FileIdentity {
	// A file whose metadata cannot be read gets a zeroed identity, which still
	// compares equal to itself — so it is poolable — and the open that follows
	// is what reports the real error.
	let (len, modified_nanos) = std::fs::metadata(path)
		.map(|meta| {
			let modified = meta
				.modified()
				.ok()
				.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
				.map_or(0, |age| age.as_nanos());
			(meta.len(), modified)
		})
		.unwrap_or((0, 0));
	FileIdentity {
		path: path.to_path_buf(),
		variant: variant.to_string(),
		len,
		modified_nanos,
	}
}

struct Slot<T> {
	identity: FileIdentity,
	reader: Arc<Mutex<T>>,
}

/// Readers held between calls, least recently used first.
///
/// `Tag` exists to make two pools over the same reader type *different types*.
/// Tauri keys managed state by type, so two pools of `AudioReader` would be one
/// slot and the second `manage` call would panic — and merging them would be
/// worse than the panic: the waveform scans a track forwards while playback
/// streams it, and sharing one reader means sharing one seek position, so each
/// would keep throwing the other's away. The tag says at the type level that
/// these are separate pools for separate purposes.
pub struct ReaderPool<T, Tag = ()> {
	slots: Mutex<Vec<Slot<T>>>,
	capacity: usize,
	tag: PhantomData<fn() -> Tag>,
}

impl<T, Tag> Default for ReaderPool<T, Tag> {
	fn default() -> Self {
		Self::new(DEFAULT_CAPACITY)
	}
}

impl<T, Tag> ReaderPool<T, Tag> {
	pub fn new(capacity: usize) -> Self {
		Self {
			slots: Mutex::new(Vec::new()),
			capacity: capacity.max(1),
			tag: PhantomData,
		}
	}

	/// The reader for `path`, opening one if this file is not already held.
	///
	/// The returned reader is shared: the caller locks it for the length of one
	/// read, and a second caller on the same file waits. That is deliberate —
	/// they are sharing one seek position, so they could not overlap anyway.
	pub fn checkout<F>(
		&self,
		path: &Path,
		variant: &str,
		open: F,
	) -> Result<Arc<Mutex<T>>, String>
	where
		F: FnOnce() -> Result<T, String>,
	{
		let identity = identity(path, variant);
		if let Some(reader) = self.matching(&identity) {
			return Ok(reader);
		}

		// `open` runs outside the pool lock. Parsing a container header is tens
		// of milliseconds, and holding the lock across it would put every other
		// file behind this one — which is the cost this pool exists to remove.
		// Two callers racing on the same cold file therefore both open it, and
		// the second's context replaces the first in the pool: one wasted open,
		// never a wrong answer.
		let reader = Arc::new(Mutex::new(open()?));
		self.file(identity, reader.clone());
		Ok(reader)
	}

	/// The held reader for this exact file version, promoted to most recently
	/// used. Also drops any reader for the same path at a *different* version,
	/// which is a file that has been replaced on disk.
	fn matching(&self, identity: &FileIdentity) -> Option<Arc<Mutex<T>>> {
		let mut slots = self.slots.lock().ok()?;
		let mut found = None;
		let mut index = 0;
		while index < slots.len() {
			if slots[index].identity == *identity {
				let slot = slots.remove(index);
				found = Some(slot.reader);
				continue;
			}
			// The same file at a different length or modification time is a file
			// that has been replaced, and every reader over it — whatever shape
			// it was built for — is now reading a header that is gone. A reader
			// for the same version in a *different* shape is a legitimate
			// sibling and is left alone.
			if slots[index].identity.path == identity.path
				&& (slots[index].identity.len != identity.len
					|| slots[index].identity.modified_nanos != identity.modified_nanos)
			{
				slots.remove(index);
				continue;
			}
			index += 1;
		}
		let reader = found?;
		slots.push(Slot {
			identity: identity.clone(),
			reader: reader.clone(),
		});
		Some(reader)
	}

	fn file(&self, identity: FileIdentity, reader: Arc<Mutex<T>>) {
		let Ok(mut slots) = self.slots.lock() else {
			return;
		};
		slots.retain(|slot| {
			slot.identity.path != identity.path || slot.identity.variant != identity.variant
		});
		slots.push(Slot { identity, reader });
		while slots.len() > self.capacity {
			slots.remove(0);
		}
	}

	/// Drops whatever is held for `path`. Called when a source leaves the
	/// project, so its file descriptor does not outlive it.
	pub fn forget(&self, path: &Path) {
		if let Ok(mut slots) = self.slots.lock() {
			slots.retain(|slot| slot.identity.path != path);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::cell::Cell;

	/// A pool whose "open" only counts, so a test can assert how many times a
	/// file was opened rather than how long it took.
	struct Counting {
		pool: ReaderPool<u32>,
		opens: Cell<u32>,
	}

	/// Two pools over the same reader type have to be distinct types, or Tauri's
	/// `manage` — which keys state by type — panics on the second one.
	#[test]
	fn a_tag_makes_two_pools_of_one_reader_distinct_types() {
		struct First;
		struct Second;
		fn type_of<T: 'static>() -> &'static str {
			std::any::type_name::<T>()
		}
		assert_ne!(
			type_of::<ReaderPool<u32, First>>(),
			type_of::<ReaderPool<u32, Second>>()
		);
	}

	impl Counting {
		fn new(capacity: usize) -> Self {
			Self {
				pool: ReaderPool::new(capacity),
				opens: Cell::new(0),
			}
		}

		fn checkout(&self, path: &Path) -> u32 {
			self.checkout_variant(path, "")
		}

		fn checkout_variant(&self, path: &Path, variant: &str) -> u32 {
			let reader = self
				.pool
				.checkout(path, variant, || {
					self.opens.set(self.opens.get() + 1);
					Ok(self.opens.get())
				})
				.expect("checkout succeeds");
			let value = *reader.lock().expect("reader locks");
			value
		}
	}

	/// A distinct temporary file per test, cleaned up by the caller.
	fn fixture(name: &str, body: &[u8]) -> PathBuf {
		let path = std::env::temp_dir().join(format!("bluper_pool_{name}"));
		std::fs::write(&path, body).expect("fixture writes");
		path
	}

	#[test]
	fn reuses_a_reader_for_the_same_file() {
		let pool = Counting::new(4);
		let file = fixture("reuse", b"one");

		for _ in 0..3 {
			assert_eq!(pool.checkout(&file), 1);
		}
		assert_eq!(
			pool.opens.get(),
			1,
			"the container is opened once, not per call"
		);

		let _ = std::fs::remove_file(&file);
	}

	#[test]
	fn reopens_when_the_file_is_replaced() {
		let pool = Counting::new(4);
		let file = fixture("replaced", b"one");
		assert_eq!(pool.checkout(&file), 1);

		// A different length is a different file, whatever the path says. Left
		// unnoticed, the retained context would answer from the old header and
		// hand back packets at offsets that no longer exist.
		std::fs::write(&file, b"a longer body").expect("fixture rewrites");
		assert_eq!(pool.checkout(&file), 2);
		assert_eq!(
			pool.opens.get(),
			2,
			"a replaced file is a miss, not a stale hit"
		);

		let _ = std::fs::remove_file(&file);
	}

	/// An audio reader resamples to one shape, so two shapes over one file have
	/// to be two readers. Sharing them would hand a caller asking for 44.1kHz
	/// mono a reader built for 48kHz stereo.
	#[test]
	fn variants_of_one_file_are_separate_readers() {
		let pool = Counting::new(4);
		let file = fixture("variants", b"one");

		assert_eq!(pool.checkout_variant(&file, "48000:2"), 1);
		assert_eq!(pool.checkout_variant(&file, "44100:1"), 2);
		// Each is then reused rather than rebuilt, which is the point of keeping
		// both instead of replacing one with the other.
		assert_eq!(pool.checkout_variant(&file, "48000:2"), 1);
		assert_eq!(pool.checkout_variant(&file, "44100:1"), 2);
		assert_eq!(pool.opens.get(), 2);

		// A replaced file invalidates every shape of it, not just the one asked
		// for: they are all reading a header that is gone.
		std::fs::write(&file, b"a longer body").expect("fixture rewrites");
		assert_eq!(pool.checkout_variant(&file, "48000:2"), 3);
		assert_eq!(pool.checkout_variant(&file, "44100:1"), 4);
		assert_eq!(pool.opens.get(), 4);

		let _ = std::fs::remove_file(&file);
	}

	#[test]
	fn evicts_the_least_recently_used() {
		let pool = Counting::new(2);
		let files: Vec<PathBuf> = (0..3)
			.map(|index| fixture(&format!("lru_{index}"), b"body"))
			.collect();

		pool.checkout(&files[0]);
		pool.checkout(&files[1]);
		// Touching 0 makes 1 the oldest, so 2 arriving should evict 1 and leave
		// 0 held.
		pool.checkout(&files[0]);
		pool.checkout(&files[2]);
		assert_eq!(pool.opens.get(), 3);

		pool.checkout(&files[1]);
		assert_eq!(pool.opens.get(), 4, "1 was the one evicted");
		pool.checkout(&files[2]);
		assert_eq!(pool.opens.get(), 4, "2 is still held");

		for path in &files {
			let _ = std::fs::remove_file(path);
		}
	}

	#[test]
	fn forget_drops_the_held_reader() {
		let pool = Counting::new(4);
		let file = fixture("forget", b"one");

		pool.checkout(&file);
		pool.checkout(&file);
		assert_eq!(pool.opens.get(), 1);

		pool.pool.forget(&file);
		pool.checkout(&file);
		assert_eq!(
			pool.opens.get(),
			2,
			"forgetting means the next call opens again"
		);

		let _ = std::fs::remove_file(&file);
	}
}
