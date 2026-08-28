//! The project envelope, and the check that a stored one is loadable.
//!
//! What this is *not*: the document model. `scenes[].tracks` is deliberately
//! absent — serde ignores it, so it passes through untouched on the TypeScript
//! side. Typing the element tree is a later step; this covers the envelope
//! around it, which had no validation at all.
//!
//! Every view type here is permissive about *presence* (`Option` + `default`)
//! and strict about type. A stored project missing its `fps` should come back
//! as a defect that names the problem, not as a deserialisation failure, and
//! certainly not as a renderer crash three screens later.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::{FrameRate, MediaTime};

/// Stamped onto every project that is saved. There has only ever been one
/// version, so a project carrying anything else was not written by this build.
#[export]
pub const CURRENT_PROJECT_VERSION: u32 = 1;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSize {
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Background {
    Color { color: String },
    Blur { blur_intensity: f64 },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(default)]
    pub fps: Option<FrameRate>,
    #[serde(default)]
    pub canvas_size: Option<CanvasSize>,
    #[serde(default)]
    pub background: Option<Background>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetadataView {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub duration: Option<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkView {
    #[serde(default)]
    pub time: Option<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SceneView {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub is_main: Option<bool>,
    #[serde(default)]
    pub bookmarks: Option<Vec<BookmarkView>>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub metadata: Option<MetadataView>,
    #[serde(default)]
    pub settings: Option<SettingsView>,
    #[serde(default)]
    pub current_scene_id: Option<String>,
    #[serde(default)]
    pub scenes: Option<Vec<SceneView>>,
}

/// Whether a defect should stop a project from loading.
///
/// The distinction is not cosmetic. `ScenesManager::initializeScenes` already
/// copes with several of these — `ensureMainScene` prepends a main scene when
/// none is marked (which also covers a project with no scenes at all), and a
/// `currentSceneId` naming nothing falls back to the main scene. Refusing to
/// load those would *lose* a project the editor currently repairs, which is
/// worse than the missing validation this replaces.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DefectSeverity {
    /// The editor cannot make a usable project out of this.
    Fatal,
    /// The editor already handles this; worth logging, not worth refusing.
    Tolerated,
}

/// What is wrong with a stored project, in terms a caller can branch on.
///
/// Deliberately not a string. A rejected project is an expected outcome, not a
/// bug, and the UI has to tell the difference between "written by a newer build"
/// and "the frame rate cannot be represented" — which a flattened message
/// cannot support without parsing English back out.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProjectDefect {
    /// Written by a different build. There is no migration chain.
    UnsupportedVersion { found: Option<u32>, expected: u32 },
    MissingMetadata,
    MissingProjectId,
    MissingSettings,
    MissingFrameRate,
    /// A zero numerator or denominator: not a rate at all.
    InvalidFrameRate { numerator: u32, denominator: u32 },
    /// A rate whose frame boundaries do not land on the integer tick lattice,
    /// so no frame time is exactly representable.
    UnrepresentableFrameRate { numerator: u32, denominator: u32 },
    MissingCanvasSize,
    /// Zero, negative, non-finite or non-integral canvas dimensions.
    InvalidCanvasSize { width: f64, height: f64 },
    MissingBackground,
    NegativeDuration { ticks: i64 },
    NoScenes,
    SceneMissingId { index: usize },
    DuplicateSceneId { id: String },
    NoMainScene,
    MultipleMainScenes { count: usize },
    /// `currentSceneId` names a scene the project does not contain.
    CurrentSceneMissing { id: String },
    NegativeBookmarkTime { scene_id: String, ticks: i64 },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ValidateProjectOptions {
    pub project: ProjectView,
}

/// The crossing type. Partitioned rather than handed over as one list, so the
/// caller decides what to do with each bucket instead of re-deriving severity.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectValidation {
    /// Refuse the project.
    pub fatal: Vec<ProjectDefect>,
    /// Log it and carry on.
    pub tolerated: Vec<ProjectDefect>,
}

#[export]
pub fn validate_project_envelope(
    ValidateProjectOptions { project }: ValidateProjectOptions,
) -> ProjectValidation {
    let (fatal, tolerated) = validate_project(&project)
        .into_iter()
        .partition(|defect| defect.severity() == DefectSeverity::Fatal);
    ProjectValidation { fatal, tolerated }
}

impl ProjectDefect {
    pub fn severity(&self) -> DefectSeverity {
        match self {
            // Everything `loadProject` reads directly, or that the renderer
            // cannot start without.
            ProjectDefect::UnsupportedVersion { .. }
            | ProjectDefect::MissingMetadata
            | ProjectDefect::MissingProjectId
            | ProjectDefect::MissingSettings
            | ProjectDefect::MissingFrameRate
            | ProjectDefect::InvalidFrameRate { .. }
            | ProjectDefect::UnrepresentableFrameRate { .. }
            | ProjectDefect::MissingCanvasSize
            | ProjectDefect::InvalidCanvasSize { .. }
            | ProjectDefect::MissingBackground => DefectSeverity::Fatal,

            // Repaired on load, or survivable with the scene list slightly odd.
            ProjectDefect::NoScenes
            | ProjectDefect::NoMainScene
            | ProjectDefect::MultipleMainScenes { .. }
            | ProjectDefect::CurrentSceneMissing { .. }
            | ProjectDefect::SceneMissingId { .. }
            | ProjectDefect::DuplicateSceneId { .. }
            | ProjectDefect::NegativeDuration { .. }
            | ProjectDefect::NegativeBookmarkTime { .. } => DefectSeverity::Tolerated,
        }
    }
}

/// Collect everything wrong with a project, rather than stopping at the first
/// problem: a corrupt file usually has several, and reporting them one reload at
/// a time is a poor way to find out.
pub fn validate_project(project: &ProjectView) -> Vec<ProjectDefect> {
    let mut defects = Vec::new();

    if project.version != Some(CURRENT_PROJECT_VERSION) {
        defects.push(ProjectDefect::UnsupportedVersion {
            found: project.version,
            expected: CURRENT_PROJECT_VERSION,
        });
    }

    match &project.metadata {
        None => defects.push(ProjectDefect::MissingMetadata),
        Some(metadata) => {
            if metadata.id.as_deref().unwrap_or("").is_empty() {
                defects.push(ProjectDefect::MissingProjectId);
            }
            if let Some(duration) = metadata.duration {
                if duration.as_ticks() < 0 {
                    defects.push(ProjectDefect::NegativeDuration {
                        ticks: duration.as_ticks(),
                    });
                }
            }
        }
    }

    match &project.settings {
        None => defects.push(ProjectDefect::MissingSettings),
        Some(settings) => {
            validate_frame_rate(settings.fps.as_ref(), &mut defects);
            validate_canvas_size(settings.canvas_size.as_ref(), &mut defects);
            if settings.background.is_none() {
                defects.push(ProjectDefect::MissingBackground);
            }
        }
    }

    validate_scenes(project, &mut defects);

    defects
}

fn validate_frame_rate(fps: Option<&FrameRate>, defects: &mut Vec<ProjectDefect>) {
    let Some(fps) = fps else {
        defects.push(ProjectDefect::MissingFrameRate);
        return;
    };

    if !fps.is_valid() {
        defects.push(ProjectDefect::InvalidFrameRate {
            numerator: fps.numerator,
            denominator: fps.denominator,
        });
        return;
    }

    // A rate the tick lattice cannot express would make every frame time an
    // approximation, which is exactly what integer ticks exist to prevent.
    if fps.ticks_per_frame().is_none() {
        defects.push(ProjectDefect::UnrepresentableFrameRate {
            numerator: fps.numerator,
            denominator: fps.denominator,
        });
    }
}

fn validate_canvas_size(size: Option<&CanvasSize>, defects: &mut Vec<ProjectDefect>) {
    let Some(size) = size else {
        defects.push(ProjectDefect::MissingCanvasSize);
        return;
    };

    let is_usable = |value: f64| value.is_finite() && value > 0.0 && value.fract() == 0.0;
    if !is_usable(size.width) || !is_usable(size.height) {
        defects.push(ProjectDefect::InvalidCanvasSize {
            width: size.width,
            height: size.height,
        });
    }
}

fn validate_scenes(project: &ProjectView, defects: &mut Vec<ProjectDefect>) {
    let scenes = project.scenes.as_deref().unwrap_or(&[]);
    if scenes.is_empty() {
        defects.push(ProjectDefect::NoScenes);
        return;
    }

    let mut seen_ids: Vec<&str> = Vec::with_capacity(scenes.len());
    let mut main_count = 0usize;

    for (index, scene) in scenes.iter().enumerate() {
        let id = scene.id.as_deref().unwrap_or("");
        if id.is_empty() {
            defects.push(ProjectDefect::SceneMissingId { index });
        } else if seen_ids.contains(&id) {
            defects.push(ProjectDefect::DuplicateSceneId { id: id.to_string() });
        } else {
            seen_ids.push(id);
        }

        if scene.is_main == Some(true) {
            main_count += 1;
        }

        for bookmark in scene.bookmarks.as_deref().unwrap_or(&[]) {
            if let Some(time) = bookmark.time {
                if time.as_ticks() < 0 {
                    defects.push(ProjectDefect::NegativeBookmarkTime {
                        scene_id: id.to_string(),
                        ticks: time.as_ticks(),
                    });
                }
            }
        }
    }

    match main_count {
        0 => defects.push(ProjectDefect::NoMainScene),
        1 => {}
        count => defects.push(ProjectDefect::MultipleMainScenes { count }),
    }

    // An empty `currentSceneId` is how a project with no selection is stored,
    // so only a non-empty one that matches nothing is a defect.
    if let Some(current) = project.current_scene_id.as_deref() {
        if !current.is_empty() && !seen_ids.contains(&current) {
            defects.push(ProjectDefect::CurrentSceneMissing {
                id: current.to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_project() -> ProjectView {
        ProjectView {
            version: Some(CURRENT_PROJECT_VERSION),
            metadata: Some(MetadataView {
                id: Some("project-1".to_string()),
                name: Some("Untitled".to_string()),
                duration: Some(MediaTime::from_ticks(120_000)),
            }),
            settings: Some(SettingsView {
                fps: Some(FrameRate::FPS_30),
                canvas_size: Some(CanvasSize {
                    width: 1920.0,
                    height: 1080.0,
                }),
                background: Some(Background::Color {
                    color: "#000000".to_string(),
                }),
            }),
            current_scene_id: Some("scene-1".to_string()),
            scenes: Some(vec![SceneView {
                id: Some("scene-1".to_string()),
                is_main: Some(true),
                bookmarks: Some(vec![BookmarkView {
                    time: Some(MediaTime::from_ticks(60_000)),
                }]),
            }]),
        }
    }

    #[test]
    fn a_well_formed_project_has_no_defects() {
        assert_eq!(validate_project(&valid_project()), vec![]);
    }

    #[test]
    fn a_missing_version_is_unsupported_rather_than_assumed_current() {
        let mut project = valid_project();
        project.version = None;
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::UnsupportedVersion {
                found: None,
                expected: CURRENT_PROJECT_VERSION,
            }]
        );
    }

    #[test]
    fn a_future_version_is_reported_with_what_was_found() {
        let mut project = valid_project();
        project.version = Some(7);
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::UnsupportedVersion {
                found: Some(7),
                expected: CURRENT_PROJECT_VERSION,
            }]
        );
    }

    #[test]
    fn a_zero_frame_rate_is_invalid_not_unrepresentable() {
        let mut project = valid_project();
        project.settings.as_mut().unwrap().fps = Some(FrameRate {
            numerator: 0,
            denominator: 1,
        });
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::InvalidFrameRate {
                numerator: 0,
                denominator: 1,
            }]
        );
    }

    #[test]
    fn a_rate_off_the_tick_lattice_is_rejected() {
        // 120000 * 1 is not divisible by 7, so no frame boundary is exact.
        let mut project = valid_project();
        project.settings.as_mut().unwrap().fps = Some(FrameRate {
            numerator: 7,
            denominator: 1,
        });
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::UnrepresentableFrameRate {
                numerator: 7,
                denominator: 1,
            }]
        );
    }

    #[test]
    fn ntsc_rates_stay_valid() {
        for rate in [
            FrameRate::FPS_23_976,
            FrameRate::FPS_29_97,
            FrameRate::FPS_59_94,
        ] {
            let mut project = valid_project();
            project.settings.as_mut().unwrap().fps = Some(rate);
            assert_eq!(
                validate_project(&project),
                vec![],
                "rate {}/{} should be loadable",
                rate.numerator,
                rate.denominator
            );
        }
    }

    #[test]
    fn a_fractional_canvas_size_is_rejected() {
        let mut project = valid_project();
        project.settings.as_mut().unwrap().canvas_size = Some(CanvasSize {
            width: 1920.5,
            height: 1080.0,
        });
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::InvalidCanvasSize {
                width: 1920.5,
                height: 1080.0,
            }]
        );
    }

    #[test]
    fn a_zero_canvas_size_is_rejected() {
        let mut project = valid_project();
        project.settings.as_mut().unwrap().canvas_size = Some(CanvasSize {
            width: 0.0,
            height: 1080.0,
        });
        assert!(matches!(
            validate_project(&project).as_slice(),
            [ProjectDefect::InvalidCanvasSize { .. }]
        ));
    }

    #[test]
    fn missing_settings_reports_once_not_once_per_field() {
        let mut project = valid_project();
        project.settings = None;
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::MissingSettings]
        );
    }

    #[test]
    fn a_duplicate_scene_id_is_caught() {
        let mut project = valid_project();
        let scenes = project.scenes.as_mut().unwrap();
        scenes.push(SceneView {
            id: Some("scene-1".to_string()),
            is_main: Some(false),
            bookmarks: None,
        });
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::DuplicateSceneId {
                id: "scene-1".to_string()
            }]
        );
    }

    #[test]
    fn exactly_one_main_scene_is_required() {
        let mut project = valid_project();
        project.scenes.as_mut().unwrap()[0].is_main = Some(false);
        assert_eq!(validate_project(&project), vec![ProjectDefect::NoMainScene]);

        let mut project = valid_project();
        project.scenes.as_mut().unwrap().push(SceneView {
            id: Some("scene-2".to_string()),
            is_main: Some(true),
            bookmarks: None,
        });
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::MultipleMainScenes { count: 2 }]
        );
    }

    #[test]
    fn a_dangling_current_scene_id_is_caught_but_an_empty_one_is_not() {
        let mut project = valid_project();
        project.current_scene_id = Some("scene-missing".to_string());
        assert_eq!(
            validate_project(&project),
            vec![ProjectDefect::CurrentSceneMissing {
                id: "scene-missing".to_string()
            }]
        );

        let mut project = valid_project();
        project.current_scene_id = Some(String::new());
        assert_eq!(validate_project(&project), vec![]);
    }

    #[test]
    fn negative_times_are_caught_in_metadata_and_bookmarks() {
        let mut project = valid_project();
        project.metadata.as_mut().unwrap().duration = Some(MediaTime::from_ticks(-1));
        project.scenes.as_mut().unwrap()[0].bookmarks = Some(vec![BookmarkView {
            time: Some(MediaTime::from_ticks(-5)),
        }]);
        assert_eq!(
            validate_project(&project),
            vec![
                ProjectDefect::NegativeDuration { ticks: -1 },
                ProjectDefect::NegativeBookmarkTime {
                    scene_id: "scene-1".to_string(),
                    ticks: -5,
                },
            ]
        );
    }

    #[test]
    fn every_defect_in_a_thoroughly_broken_project_is_reported_together() {
        let defects = validate_project(&ProjectView::default());
        assert!(defects.len() >= 4, "got {defects:?}");
        assert!(defects.contains(&ProjectDefect::MissingMetadata));
        assert!(defects.contains(&ProjectDefect::MissingSettings));
        assert!(defects.contains(&ProjectDefect::NoScenes));
    }

    #[test]
    fn scene_problems_the_editor_repairs_are_not_fatal() {
        // `ensureMainScene` prepends a main scene, and a dangling
        // `currentSceneId` falls back to it. Refusing the project here would
        // lose one the editor fixes by itself.
        let mut project = valid_project();
        project.scenes = Some(vec![]);
        project.current_scene_id = Some("gone".to_string());
        let validation = validate_project_envelope(ValidateProjectOptions { project });
        assert_eq!(validation.fatal, vec![]);
        assert!(validation.tolerated.contains(&ProjectDefect::NoScenes));
    }

    #[test]
    fn settings_problems_are_fatal() {
        let mut project = valid_project();
        project.settings = None;
        let validation = validate_project_envelope(ValidateProjectOptions { project });
        assert_eq!(validation.fatal, vec![ProjectDefect::MissingSettings]);
        assert_eq!(validation.tolerated, vec![]);
    }

    #[test]
    fn every_defect_lands_in_exactly_one_bucket() {
        let project = ProjectView::default();
        let all = validate_project(&project);
        let validation = validate_project_envelope(ValidateProjectOptions {
            project: ProjectView::default(),
        });
        assert_eq!(all.len(), validation.fatal.len() + validation.tolerated.len());
    }

    #[test]
    fn tracks_are_ignored_rather_than_parsed() {
        // The element tree is not typed here; a project whose tracks are shaped
        // in a way this crate knows nothing about still validates.
        let json = r##"{
            "version": 1,
            "metadata": { "id": "p", "name": "n", "duration": 0 },
            "settings": {
                "fps": { "numerator": 30, "denominator": 1 },
                "canvasSize": { "width": 1920, "height": 1080 },
                "background": { "type": "color", "color": "#000" }
            },
            "currentSceneId": "s",
            "scenes": [{
                "id": "s",
                "isMain": true,
                "bookmarks": [],
                "tracks": { "anything": [1, 2, {"nested": true}] }
            }]
        }"##;
        let project: ProjectView = serde_json::from_str(json).expect("should deserialize");
        assert_eq!(validate_project(&project), vec![]);
    }
}
