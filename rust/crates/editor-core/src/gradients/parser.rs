//! CSS gradient parsing.
//!
//! A port of `rafaelcaricio/gradient-parser`, which the editor vendored to read
//! the `linear-gradient(...)` / `radial-gradient(...)` declarations a project
//! stores as a background string. The original is a hand-rolled recursive
//! descent parser over a table of anchored regexes, and this keeps that shape:
//! each token below is the same regex written out, and each `match_*` function
//! is the same alternative in the same order.
//!
//! Faithfulness matters more than tidiness here, because the AST is a wire
//! format — the canvas renderer above switches on the tags — and because the
//! CSS this accepts is broader and looser than the specification. Three places
//! where the original is odd and this deliberately stays odd are called out at
//! the function that owns them: `matchAngle` throws away the unit, `matchEllipse`
//! has an unreachable alternative, and `/^at/` matches inside a longer word.
//!
//! What is *not* reproduced: the original keeps the remaining input in a module
//! level `let`, so two parses cannot overlap. [`Cursor`] holds it instead.

use bridge::export;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

/// Which of the four gradient functions produced this node. Serialises as the
/// bare CSS name, matching the `type` field on the TypeScript AST.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum GradientKind {
    #[serde(rename = "linear-gradient")]
    LinearGradient,
    #[serde(rename = "repeating-linear-gradient")]
    RepeatingLinearGradient,
    #[serde(rename = "radial-gradient")]
    RadialGradient,
    #[serde(rename = "repeating-radial-gradient")]
    RepeatingRadialGradient,
}

impl GradientKind {
    /// The CSS function name this kind is spelled with, which is also the token
    /// the parser looks for.
    const fn css_name(self) -> &'static str {
        match self {
            Self::LinearGradient => "linear-gradient",
            Self::RepeatingLinearGradient => "repeating-linear-gradient",
            Self::RadialGradient => "radial-gradient",
            Self::RepeatingRadialGradient => "repeating-radial-gradient",
        }
    }

    /// Radial gradients take a *list* of orientation nodes; linear ones take a
    /// single direction. The two are different enough that the caller has to
    /// know which matcher to run.
    const fn is_radial(self) -> bool {
        matches!(self, Self::RadialGradient | Self::RepeatingRadialGradient)
    }
}

/// A length, percentage, position keyword or `calc()` expression. Values stay
/// as the source text — nothing is converted to a number here, because the
/// renderer needs the unit to resolve a `px` against the gradient's length.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientDistance {
    #[serde(rename = "%")]
    Percent { value: String },
    #[serde(rename = "position-keyword")]
    PositionKeyword { value: String },
    #[serde(rename = "calc")]
    Calc { value: String },
    #[serde(rename = "px")]
    Px { value: String },
    #[serde(rename = "em")]
    Em { value: String },
}

/// `closest-side`, `cover` and friends, as a node of its own. The radial
/// orientation list has its own extent variant (it can carry an `at` clause);
/// this is the plainer one that appears as a shape's `style`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientExtentKeyword {
    #[serde(rename = "extent-keyword")]
    ExtentKeyword { value: String },
}

/// The `x`/`y` pair inside a position node. Both keys are always present in the
/// JavaScript object — `matchCoordinates` writes them unconditionally — so
/// neither is skipped when it is `None`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GradientPositionValue {
    pub x: Option<GradientDistance>,
    pub y: Option<GradientDistance>,
}

/// `{ type: "position", value: { x, y } }`. The tag never varies, but it is on
/// the wire, so it is modelled as a one-variant tagged enum rather than a
/// literal string field a caller could set to anything.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientPosition {
    #[serde(rename = "position")]
    Position { value: GradientPositionValue },
}

/// `circle` or `ellipse`. The parser lowercases whatever the source wrote, so
/// `CIRCLE(` still lands on [`Self::Circle`].
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GradientShapeValue {
    Circle,
    Ellipse,
}

/// What follows a `circle`/`ellipse` keyword: a size, an extent keyword, or a
/// position pair standing in for a width and a height. Untagged, because each
/// member already carries its own `type`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum GradientShapeStyle {
    Distance(GradientDistance),
    ExtentKeyword(GradientExtentKeyword),
    Position(GradientPosition),
}

/// One entry of a radial gradient's orientation list.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientRadialOrientation {
    /// An explicit `circle`/`ellipse`, or a bare `<width> <height> at <pos>`
    /// that the original reports as an ellipse. `style` and `at` are always
    /// written, even when absent, because the JavaScript assigns them
    /// unconditionally.
    #[serde(rename = "shape")]
    Shape {
        value: GradientShapeValue,
        style: Option<GradientShapeStyle>,
        at: Option<GradientPosition>,
    },
    /// An extent keyword on its own. Unlike `Shape`, the `at` key is absent
    /// rather than `undefined` when there is no `at` clause — the JavaScript
    /// builds this node two different ways depending on whether one followed.
    #[serde(rename = "extent-keyword")]
    ExtentKeyword {
        value: String,
        #[cfg_attr(feature = "wasm", tsify(optional))]
        #[serde(skip_serializing_if = "Option::is_none")]
        at: Option<GradientPosition>,
    },
    /// A position with no shape or extent in front of it, from either `at
    /// center` or a bare `center`.
    #[serde(rename = "default-radial")]
    DefaultRadial { at: GradientPosition },
}

/// A linear gradient's direction: a side-or-corner keyword, or an angle.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientLinearOrientation {
    #[serde(rename = "directional")]
    Directional { value: String },
    #[serde(rename = "angular")]
    Angular { value: String },
}

/// Whatever sat between the opening paren and the first colour stop. Linear
/// gradients produce one node; radial ones produce a list, so this is a union
/// of an object and an array — untagged, matching the TypeScript exactly.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum GradientOrientation {
    Linear(GradientLinearOrientation),
    Radial(Vec<GradientRadialOrientation>),
}

/// A colour in whichever notation it was written in. Component values stay as
/// text: `rgb(255, 0, 0)` keeps `"255"`, not `255`.
///
/// `Rgb`/`Rgba` hold a list because the parser does not check the arity —
/// `rgb(1, 2)` parses. `Hsl`/`Hsla` are typed as tuples on the TypeScript side
/// but travel as arrays of three and four, which is what a `Vec` produces.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientColor {
    /// The digits without the `#`, however many there were.
    #[serde(rename = "hex")]
    Hex { value: String },
    /// A bare word — a named colour, `transparent`, or a typo.
    #[serde(rename = "literal")]
    Literal { value: String },
    #[serde(rename = "rgb")]
    Rgb { value: Vec<String> },
    #[serde(rename = "rgba")]
    Rgba { value: Vec<String> },
    #[serde(rename = "hsl")]
    Hsl { value: Vec<String> },
    #[serde(rename = "hsla")]
    Hsla { value: Vec<String> },
    /// A `var(--name)` reference, `--` included, resolved further up.
    #[serde(rename = "var")]
    Var { value: String },
}

/// A colour plus the optional length that positioned it in the stop list.
///
/// The TypeScript spells this `Color & { length?: Distance }` and builds it with
/// `{ ...color, length }`, so `length` sits beside `type` and `value` rather
/// than nested. `#[serde(flatten)]` would say that in one place, but a flattened
/// struct serialises through `serialize_map` and reaches JavaScript as a real
/// `Map` whose `.type` is `undefined` — so the variants are written out and
/// [`Self::from_color`] does the joining.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GradientColorStop {
    #[serde(rename = "hex")]
    Hex {
        value: String,
        length: Option<GradientDistance>,
    },
    #[serde(rename = "literal")]
    Literal {
        value: String,
        length: Option<GradientDistance>,
    },
    #[serde(rename = "rgb")]
    Rgb {
        value: Vec<String>,
        length: Option<GradientDistance>,
    },
    #[serde(rename = "rgba")]
    Rgba {
        value: Vec<String>,
        length: Option<GradientDistance>,
    },
    #[serde(rename = "hsl")]
    Hsl {
        value: Vec<String>,
        length: Option<GradientDistance>,
    },
    #[serde(rename = "hsla")]
    Hsla {
        value: Vec<String>,
        length: Option<GradientDistance>,
    },
    #[serde(rename = "var")]
    Var {
        value: String,
        length: Option<GradientDistance>,
    },
}

impl GradientColorStop {
    /// Attach a length to a parsed colour.
    fn from_color(color: GradientColor, length: Option<GradientDistance>) -> Self {
        match color {
            GradientColor::Hex { value } => Self::Hex { value, length },
            GradientColor::Literal { value } => Self::Literal { value, length },
            GradientColor::Rgb { value } => Self::Rgb { value, length },
            GradientColor::Rgba { value } => Self::Rgba { value, length },
            GradientColor::Hsl { value } => Self::Hsl { value, length },
            GradientColor::Hsla { value } => Self::Hsla { value, length },
            GradientColor::Var { value } => Self::Var { value, length },
        }
    }
}

/// One gradient function call.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GradientAst {
    #[serde(rename = "type")]
    pub kind: GradientKind,
    /// Absent when the gradient opened straight onto its colour stops. The key
    /// is still written, as `undefined`, which is what the JavaScript object has.
    pub orientation: Option<GradientOrientation>,
    pub color_stops: Vec<GradientColorStop>,
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// JavaScript's `\s`, which the token table's blank-skipper and
/// `String.prototype.trim` both use. Rust's `char::is_whitespace` is the Unicode
/// `White_Space` property and the two disagree on `U+FEFF`, so the set is
/// written out rather than delegated.
const fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'..='\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`, over the set above.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// The end offsets a backtracking engine would try for
/// `([0-9]*\.[0-9]+)|([0-9]+\.?)`, in the order it would try them.
///
/// Only the order matters, and only when a unit follows: `12.px` parses because
/// the second alternative offers `12.` before it offers `12`, and `1.2px` parses
/// because the first alternative is preferred over both. An empty result means
/// neither alternative can match here at all.
fn number_candidate_lengths(text: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let leading = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let mut candidates = Vec::new();

    // `[0-9]*\.[0-9]+`. The star has to take *every* leading digit: after a
    // shorter run the next character is a digit, never the dot it needs.
    if bytes.get(leading) == Some(&b'.') {
        let fraction = bytes[leading + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        for taken in (1..=fraction).rev() {
            candidates.push(leading + 1 + taken);
        }
    }

    // `[0-9]+\.?`, greedy then shrinking. The optional dot only survives on the
    // longest run, for the same reason.
    if leading >= 1 {
        if bytes.get(leading) == Some(&b'.') {
            candidates.push(leading + 1);
        }
        for taken in (1..=leading).rev() {
            candidates.push(taken);
        }
    }

    candidates
}

/// The remaining input, and every token that can be taken off the front of it.
///
/// Each `scan_*` skips leading blanks *first*, and leaves them skipped even when
/// its own token does not match. That is what the JavaScript `scan` does, and
/// later alternatives depend on it: `match_definition` tries four gradient names
/// against the same cursor in a row.
struct Cursor<'a> {
    input: &'a str,
}

impl<'a> Cursor<'a> {
    const fn new(input: &'a str) -> Self {
        Self { input }
    }

    /// The JavaScript builds its message from what is *left* of the input rather
    /// than from the original source, and that is kept so a message read off one
    /// implementation matches the other.
    fn error(&self, message: &str) -> String {
        format!("{}: {}", self.input, message)
    }

    fn consume(&mut self, size: usize) {
        self.input = &self.input[size..];
    }

    fn skip_blanks(&mut self) {
        let end = self
            .input
            .find(|character: char| !is_js_space(character))
            .unwrap_or(self.input.len());
        self.consume(end);
    }

    /// An ASCII-case-insensitive literal, without the blank skip — for
    /// alternatives tried inside one token.
    ///
    /// ASCII-only is exactly right rather than a shortcut: a JavaScript regex
    /// without the `u` flag refuses to fold a non-ASCII character onto an ASCII
    /// one, so `ſ` does not match `s` there either.
    fn take_ci(&mut self, literal: &str) -> Option<&'a str> {
        let input = self.input;
        let candidate = input.get(..literal.len())?;
        if !candidate.eq_ignore_ascii_case(literal) {
            return None;
        }
        self.consume(literal.len());
        Some(candidate)
    }

    fn scan_ci(&mut self, literal: &str) -> Option<&'a str> {
        self.skip_blanks();
        self.take_ci(literal)
    }

    /// `^,`, `^\(` and `^\)` all reduce to this.
    fn scan_char(&mut self, expected: char) -> bool {
        self.skip_blanks();
        if !self.input.starts_with(expected) {
            return false;
        }
        self.consume(expected.len_utf8());
        true
    }

    /// `^(-(webkit|o|ms|moz)-)?(<name>)`.
    ///
    /// A prefix that is not followed by the name fails outright: the engine
    /// would give the optional group back, but the name then has to sit at
    /// offset zero, where the `-` is.
    fn scan_gradient_name(&mut self, name: &str) -> bool {
        self.skip_blanks();
        let start = self.input;
        for prefix in ["-webkit-", "-o-", "-ms-", "-moz-"] {
            if self.take_ci(prefix).is_some() {
                if self.take_ci(name).is_some() {
                    return true;
                }
                self.input = start;
                return false;
            }
        }
        self.take_ci(name).is_some()
    }

    /// `^to (left (top|bottom)|…|bottom)`, returning capture 1 — the direction
    /// without the `to `.
    ///
    /// The two-word forms come first in the alternation, so `to left top` is one
    /// corner rather than `left` with a stray `top` behind it. There is exactly
    /// one space after `to` and between the words, so `to  left` does not parse.
    fn scan_side_or_corner(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        let start = self.input;
        self.take_ci("to ")?;

        for direction in [
            "left top",
            "left bottom",
            "right top",
            "right bottom",
            "top left",
            "top right",
            "bottom left",
            "bottom right",
            "left",
            "right",
            "top",
            "bottom",
        ] {
            if let Some(matched) = self.take_ci(direction) {
                return Some(matched);
            }
        }

        self.input = start;
        None
    }

    /// `^(closest-side|closest-corner|farthest-side|farthest-corner|contain|cover)`.
    /// Case-*sensitive*, unlike every other keyword here — the only token in the
    /// table without an `i` flag.
    fn scan_extent_keyword(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        let input = self.input;
        for keyword in [
            "closest-side",
            "closest-corner",
            "farthest-side",
            "farthest-corner",
            "contain",
            "cover",
        ] {
            if input.starts_with(keyword) {
                self.consume(keyword.len());
                return Some(&input[..keyword.len()]);
            }
        }
        None
    }

    /// `^(left|center|right|top|bottom)`, case-insensitive.
    fn scan_position_keyword(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        for keyword in ["left", "center", "right", "top", "bottom"] {
            if let Some(matched) = self.take_ci(keyword) {
                return Some(matched);
            }
        }
        None
    }

    /// `^(-?(([0-9]*\.[0-9]+)|([0-9]+\.?)))<unit>`, returning capture 1: the
    /// signed number with the unit dropped. The unit is matched
    /// case-sensitively, so `10PX` is not a length.
    fn scan_number_with_unit(&mut self, unit: &str) -> Option<&'a str> {
        self.skip_blanks();
        let input = self.input;
        let (sign_length, digits) = match input.strip_prefix('-') {
            Some(rest) => (1usize, rest),
            None => (0usize, input),
        };

        for length in number_candidate_lengths(digits) {
            if digits[length..].starts_with(unit) {
                let number_length = sign_length + length;
                self.consume(number_length + unit.len());
                return Some(&input[..number_length]);
            }
        }

        None
    }

    /// `^(([0-9]*\.[0-9]+)|([0-9]+\.?))`. No sign, unlike the unit-suffixed
    /// tokens, so `rgb(-1, 0, 0)` is rejected while `-1px` is a length.
    fn scan_number(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        let input = self.input;
        let length = *number_candidate_lengths(input).first()?;
        self.consume(length);
        Some(&input[..length])
    }

    /// `^#([0-9a-fA-F]+)`, returning capture 1 — the digits, no `#`. The count
    /// is not checked, so `#f` and `#1234567` both parse.
    fn scan_hex_color(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        let input = self.input;
        let digits = input.strip_prefix('#')?;
        let length = digits.bytes().take_while(u8::is_ascii_hexdigit).count();
        if length == 0 {
            return None;
        }
        self.consume(1 + length);
        Some(&digits[..length])
    }

    /// `^([a-zA-Z]+)`.
    fn scan_literal_color(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        let input = self.input;
        let length = input.bytes().take_while(u8::is_ascii_alphabetic).count();
        if length == 0 {
            return None;
        }
        self.consume(length);
        Some(&input[..length])
    }

    /// `^(--[a-zA-Z0-9-,\s#]+)`, returning capture 1 with the `--` on it.
    ///
    /// Commas and whitespace are in the class, so `var(--a, #fff)` keeps its
    /// fallback inside the name instead of splitting on the comma.
    fn scan_variable_name(&mut self) -> Option<&'a str> {
        self.skip_blanks();
        let input = self.input;
        let tail = input.strip_prefix("--")?;
        let tail_length: usize = tail
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric()
                    || matches!(character, '-' | ',' | '#')
                    || is_js_space(*character)
            })
            .map(char::len_utf8)
            .sum();
        if tail_length == 0 {
            return None;
        }
        let length = 2 + tail_length;
        self.consume(length);
        Some(&input[..length])
    }
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

/// A rejection carries only its message. The JavaScript throws an `Error` with
/// the remaining input attached as `.source`; nothing reads that, and the
/// message already starts with it.
type ParseResult<T> = Result<T, String>;

impl<'a> Cursor<'a> {
    /// `matchListing`: one match, then any number of comma-separated repeats. A
    /// trailing comma is an error rather than the end of the list.
    fn match_listing<T>(
        &mut self,
        matcher: fn(&mut Self) -> ParseResult<Option<T>>,
    ) -> ParseResult<Vec<T>> {
        let mut result = Vec::new();
        let Some(first) = matcher(self)? else {
            return Ok(result);
        };
        result.push(first);

        while self.scan_char(',') {
            match matcher(self)? {
                Some(next) => result.push(next),
                None => return Err(self.error("One extra comma")),
            }
        }

        Ok(result)
    }

    fn match_definition(&mut self) -> ParseResult<Option<GradientAst>> {
        // Order is load-bearing only for the two `linear-gradient` names, since
        // neither is a prefix of the other once the whole token has to match.
        for kind in [
            GradientKind::LinearGradient,
            GradientKind::RepeatingLinearGradient,
            GradientKind::RadialGradient,
            GradientKind::RepeatingRadialGradient,
        ] {
            if let Some(gradient) = self.match_gradient(kind)? {
                return Ok(Some(gradient));
            }
        }
        Ok(None)
    }

    /// `matchGradient` folded into `matchCall`: the name, the paren, the
    /// orientation, the stops, the closing paren.
    fn match_gradient(&mut self, kind: GradientKind) -> ParseResult<Option<GradientAst>> {
        if !self.scan_gradient_name(kind.css_name()) {
            return Ok(None);
        }
        if !self.scan_char('(') {
            return Err(self.error("Missing ("));
        }

        let orientation = if kind.is_radial() {
            self.match_list_radial_orientations()?
                .map(GradientOrientation::Radial)
        } else {
            self.match_linear_orientation()?
                .map(GradientOrientation::Linear)
        };

        if orientation.is_some() && !self.scan_char(',') {
            return Err(self.error("Missing comma before color stops"));
        }

        let color_stops = self.match_listing(Self::match_color_stop)?;

        if !self.scan_char(')') {
            return Err(self.error("Missing )"));
        }

        Ok(Some(GradientAst {
            kind,
            orientation,
            color_stops,
        }))
    }

    fn match_linear_orientation(&mut self) -> ParseResult<Option<GradientLinearOrientation>> {
        if let Some(value) = self.scan_side_or_corner() {
            return Ok(Some(GradientLinearOrientation::Directional {
                value: value.to_owned(),
            }));
        }

        // A bare `left`/`top` is the pre-standard syntax. The position-keyword
        // token is what matches it, but the node is reported as `directional`.
        if let Some(value) = self.scan_position_keyword() {
            return Ok(Some(GradientLinearOrientation::Directional {
                value: value.to_owned(),
            }));
        }

        Ok(self.match_angle())
    }

    /// `<n>deg` or `<n>rad`.
    ///
    /// Both report `angular` with the unit thrown away, so `45deg` and `45rad`
    /// are indistinguishable downstream. That is a bug in the original, kept
    /// because the renderer above already compensates for it.
    fn match_angle(&mut self) -> Option<GradientLinearOrientation> {
        for unit in ["deg", "rad"] {
            if let Some(value) = self.scan_number_with_unit(unit) {
                return Some(GradientLinearOrientation::Angular {
                    value: value.to_owned(),
                });
            }
        }
        None
    }

    /// At most two radial orientation nodes — `circle closest-side, at center`.
    /// The comma is only eaten if a second node actually follows it, since the
    /// same comma otherwise introduces the colour stops.
    fn match_list_radial_orientations(
        &mut self,
    ) -> ParseResult<Option<Vec<GradientRadialOrientation>>> {
        let Some(first) = self.match_radial_orientation()? else {
            return Ok(None);
        };
        let mut orientations = vec![first];

        let lookahead_cache = self.input;
        if !self.scan_char(',') {
            return Ok(Some(orientations));
        }

        match self.match_radial_orientation()? {
            Some(next) => orientations.push(next),
            None => self.input = lookahead_cache,
        }

        Ok(Some(orientations))
    }

    fn match_radial_orientation(&mut self) -> ParseResult<Option<GradientRadialOrientation>> {
        if let Some((value, style)) = self.match_shape()? {
            let at = self.match_at_position()?;
            return Ok(Some(GradientRadialOrientation::Shape { value, style, at }));
        }

        if let Some(keyword) = self.scan_extent_keyword() {
            let at = self.match_at_position()?;
            return Ok(Some(GradientRadialOrientation::ExtentKeyword {
                value: keyword.to_owned(),
                at,
            }));
        }

        if let Some(implicit) = self.match_implicit_ellipse()? {
            return Ok(Some(implicit));
        }

        if let Some(at) = self.match_at_position()? {
            return Ok(Some(GradientRadialOrientation::DefaultRadial { at }));
        }

        if let Some(at) = self.match_positioning()? {
            return Ok(Some(GradientRadialOrientation::DefaultRadial { at }));
        }

        Ok(None)
    }

    /// `matchCircle` and `matchEllipse`. Neither keyword is followed by a word
    /// boundary in the original, so `circleish` matches `circle` and leaves
    /// `ish` for whatever comes next to choke on.
    fn match_shape(
        &mut self,
    ) -> ParseResult<Option<(GradientShapeValue, Option<GradientShapeStyle>)>> {
        if self.scan_ci("circle").is_some() {
            let style = match self.match_length() {
                Some(length) => Some(GradientShapeStyle::Distance(length)),
                None => self.extent_keyword_style(),
            };
            return Ok(Some((GradientShapeValue::Circle, style)));
        }

        if self.scan_ci("ellipse").is_some() {
            // The original has `matchPositioning() || matchDistance() ||
            // matchExtentKeyword()`. The middle alternative can never fire:
            // `matchPositioning` already runs `matchDistance` twice and only
            // fails when neither matched, so there is nothing left for a third
            // attempt. It is left out rather than written as dead code.
            let style = match self.match_positioning()? {
                Some(position) => Some(GradientShapeStyle::Position(position)),
                None => self.extent_keyword_style(),
            };
            return Ok(Some((GradientShapeValue::Ellipse, style)));
        }

        Ok(None)
    }

    fn extent_keyword_style(&mut self) -> Option<GradientShapeStyle> {
        let keyword = self.scan_extent_keyword()?;
        Some(GradientShapeStyle::ExtentKeyword(
            GradientExtentKeyword::ExtentKeyword {
                value: keyword.to_owned(),
            },
        ))
    }

    /// `<width> <height> at <position>` with no shape keyword, reported as an
    /// ellipse. All three parts are required; a partial match rewinds so the
    /// alternatives after this one see an untouched cursor.
    fn match_implicit_ellipse(&mut self) -> ParseResult<Option<GradientRadialOrientation>> {
        let lookahead_cache = self.input;

        let Some(width) = self.match_distance()? else {
            return Ok(None);
        };
        let Some(height) = self.match_distance()? else {
            self.input = lookahead_cache;
            return Ok(None);
        };
        let Some(at) = self.match_at_position()? else {
            self.input = lookahead_cache;
            return Ok(None);
        };

        Ok(Some(GradientRadialOrientation::Shape {
            value: GradientShapeValue::Ellipse,
            style: Some(GradientShapeStyle::Position(GradientPosition::Position {
                value: GradientPositionValue {
                    x: Some(width),
                    y: Some(height),
                },
            })),
            at: Some(at),
        }))
    }

    /// `at <positioning>`.
    ///
    /// The `^at` token has no word boundary and no `i` flag, so `atomic` enters
    /// this branch and then fails on the positioning that is not there. Kept:
    /// the alternative is to reject inputs the original accepts elsewhere.
    fn match_at_position(&mut self) -> ParseResult<Option<GradientPosition>> {
        self.skip_blanks();
        if !self.input.starts_with("at") {
            return Ok(None);
        }
        self.consume("at".len());

        match self.match_positioning()? {
            Some(position) => Ok(Some(position)),
            None => Err(self.error("Missing positioning value")),
        }
    }

    /// One or two distances as an `x`/`y` pair. One is enough — `ellipse 50%`
    /// yields a position whose `y` is absent.
    fn match_positioning(&mut self) -> ParseResult<Option<GradientPosition>> {
        let x = self.match_distance()?;
        let y = self.match_distance()?;

        if x.is_none() && y.is_none() {
            return Ok(None);
        }

        Ok(Some(GradientPosition::Position {
            value: GradientPositionValue { x, y },
        }))
    }

    fn match_distance(&mut self) -> ParseResult<Option<GradientDistance>> {
        if let Some(value) = self.scan_number_with_unit("%") {
            return Ok(Some(GradientDistance::Percent {
                value: value.to_owned(),
            }));
        }
        if let Some(value) = self.scan_position_keyword() {
            return Ok(Some(GradientDistance::PositionKeyword {
                value: value.to_owned(),
            }));
        }
        if let Some(distance) = self.match_calc()? {
            return Ok(Some(distance));
        }
        Ok(self.match_length())
    }

    /// `<n>px` or `<n>em`, in that order.
    fn match_length(&mut self) -> Option<GradientDistance> {
        if let Some(value) = self.scan_number_with_unit("px") {
            return Some(GradientDistance::Px {
                value: value.to_owned(),
            });
        }
        self.scan_number_with_unit("em")
            .map(|value| GradientDistance::Em {
                value: value.to_owned(),
            })
    }

    /// `calc(...)`, kept verbatim.
    ///
    /// The body is found by counting parentheses rather than parsed, which is
    /// what lets a nested `calc(100% - calc(2px))` through intact.
    fn match_calc(&mut self) -> ParseResult<Option<GradientDistance>> {
        if self.scan_ci("calc").is_none() {
            return Ok(None);
        }
        if !self.scan_char('(') {
            return Err(self.error("Missing ("));
        }

        let body = self.input;
        let mut depth = 1usize;
        let mut close = None;
        for (offset, character) in body.char_indices() {
            match character {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                close = Some(offset);
                break;
            }
        }

        let Some(close) = close else {
            return Err(self.error("Missing closing parenthesis in calc() expression"));
        };

        let value = body[..close].to_owned();
        self.consume(close);

        if !self.scan_char(')') {
            return Err(self.error("Missing )"));
        }

        Ok(Some(GradientDistance::Calc { value }))
    }

    /// A colour and the length that placed it. Never returns `None`: a stop
    /// list that has run out of colours is an error, which is how
    /// `linear-gradient()` gets rejected.
    fn match_color_stop(&mut self) -> ParseResult<Option<GradientColorStop>> {
        let Some(color) = self.match_color()? else {
            return Err(self.error("Expected color definition"));
        };
        let length = self.match_distance()?;
        Ok(Some(GradientColorStop::from_color(color, length)))
    }

    /// Every colour notation, longest name first where one is a prefix of
    /// another: `hsla` before `hsl`, `rgba` before `rgb`. The bare-word literal
    /// comes last, since it would otherwise swallow `rgb` and `var`.
    fn match_color(&mut self) -> ParseResult<Option<GradientColor>> {
        if let Some(value) = self.scan_hex_color() {
            return Ok(Some(GradientColor::Hex {
                value: value.to_owned(),
            }));
        }
        if let Some(color) = self.match_hsla_color()? {
            return Ok(Some(color));
        }
        if let Some(color) = self.match_hsl_color()? {
            return Ok(Some(color));
        }
        if let Some(value) = self.match_number_call("rgba")? {
            return Ok(Some(GradientColor::Rgba { value }));
        }
        if let Some(value) = self.match_number_call("rgb")? {
            return Ok(Some(GradientColor::Rgb { value }));
        }
        if let Some(color) = self.match_var_color()? {
            return Ok(Some(color));
        }
        if let Some(value) = self.scan_literal_color() {
            return Ok(Some(GradientColor::Literal {
                value: value.to_owned(),
            }));
        }
        Ok(None)
    }

    /// `rgb(...)` / `rgba(...)`: a comma-separated list of unsigned numbers with
    /// no arity check, so `rgb(1)` and `rgba(1,2,3,4,5)` both parse.
    fn match_number_call(&mut self, name: &str) -> ParseResult<Option<Vec<String>>> {
        if self.scan_ci(name).is_none() {
            return Ok(None);
        }
        if !self.scan_char('(') {
            return Err(self.error("Missing ("));
        }

        let value = self.match_listing(Self::match_number_entry)?;

        if !self.scan_char(')') {
            return Err(self.error("Missing )"));
        }

        Ok(Some(value))
    }

    fn match_var_color(&mut self) -> ParseResult<Option<GradientColor>> {
        if self.scan_ci("var").is_none() {
            return Ok(None);
        }
        if !self.scan_char('(') {
            return Err(self.error("Missing ("));
        }

        let Some(name) = self.scan_variable_name() else {
            return Err(self.error("Expected CSS variable name"));
        };
        let value = name.to_owned();

        if !self.scan_char(')') {
            return Err(self.error("Missing )"));
        }

        Ok(Some(GradientColor::Var { value }))
    }

    /// `hsl(h, s%, l%)`. The separating commas are optional — the blank skip
    /// alone gets `hsl(0 100% 50%)` through — but the two percentages are not.
    fn match_hsl_color(&mut self) -> ParseResult<Option<GradientColor>> {
        if self.scan_ci("hsl").is_none() {
            return Ok(None);
        }
        if !self.scan_char('(') {
            return Err(self.error("Missing ("));
        }

        // A percentage hue is the one malformed HSL the original names, and the
        // lookahead consumes it on the way to rejecting it.
        if self.scan_number_with_unit("%").is_some() {
            return Err(self.error(
                "HSL hue value must be a number in degrees (0-360) or normalized (-360 to 360), not a percentage",
            ));
        }

        let hue = self.match_number()?;
        let _ = self.scan_char(',');
        let saturation = self.scan_number_with_unit("%").map(str::to_owned);
        let _ = self.scan_char(',');
        let lightness = self.scan_number_with_unit("%").map(str::to_owned);

        let Some(saturation) = saturation else {
            return Err(self.error("Expected percentage value for saturation and lightness in HSL"));
        };
        let Some(lightness) = lightness else {
            return Err(self.error("Expected percentage value for saturation and lightness in HSL"));
        };

        if !self.scan_char(')') {
            return Err(self.error("Missing )"));
        }

        Ok(Some(GradientColor::Hsl {
            value: vec![hue, saturation, lightness],
        }))
    }

    /// `hsla(h, s%, l%, a)`.
    ///
    /// The alpha is read *before* the saturation and lightness are checked, so
    /// `hsla(0, 50%, 50%)` complains about a missing number rather than a
    /// missing percentage. The order is the original's and is kept.
    fn match_hsla_color(&mut self) -> ParseResult<Option<GradientColor>> {
        if self.scan_ci("hsla").is_none() {
            return Ok(None);
        }
        if !self.scan_char('(') {
            return Err(self.error("Missing ("));
        }

        let hue = self.match_number()?;
        let _ = self.scan_char(',');
        let saturation = self.scan_number_with_unit("%").map(str::to_owned);
        let _ = self.scan_char(',');
        let lightness = self.scan_number_with_unit("%").map(str::to_owned);
        let _ = self.scan_char(',');
        let alpha = self.match_number()?;

        let Some(saturation) = saturation else {
            return Err(
                self.error("Expected percentage value for saturation and lightness in HSLA")
            );
        };
        let Some(lightness) = lightness else {
            return Err(
                self.error("Expected percentage value for saturation and lightness in HSLA")
            );
        };

        if !self.scan_char(')') {
            return Err(self.error("Missing )"));
        }

        Ok(Some(GradientColor::Hsla {
            value: vec![hue, saturation, lightness, alpha],
        }))
    }

    /// `matchNumber`: a number, or a rejection.
    fn match_number(&mut self) -> ParseResult<String> {
        let value = self.scan_number();
        match value {
            Some(number) => Ok(number.to_owned()),
            None => Err(self.error("Expected number")),
        }
    }

    /// [`Self::match_number`] shaped for [`Self::match_listing`], which wants an
    /// `Option` even though this matcher never declines. Declining is what would
    /// turn `rgb()` into an empty component list instead of a rejection.
    fn match_number_entry(&mut self) -> ParseResult<Option<String>> {
        self.match_number().map(Some)
    }
}

/// Parse one or more comma-separated CSS gradient functions.
///
/// The input is trimmed and a single trailing `;` dropped, so a declaration
/// pasted straight out of a stylesheet parses as-is. Anything left over after
/// the last gradient is an error rather than ignored.
pub fn parse_gradient(code: &str) -> Result<Vec<GradientAst>, String> {
    let trimmed = js_trim(code);
    let source = trimmed.strip_suffix(';').unwrap_or(trimmed);

    let mut cursor = Cursor::new(source);
    let ast = cursor.match_listing(Cursor::match_definition)?;

    if !cursor.input.is_empty() {
        return Err(cursor.error("Invalid input not EOF"));
    }

    Ok(ast)
}

// ---------------------------------------------------------------------------
// Bridge surface
// ---------------------------------------------------------------------------

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GradientParseOptions {
    pub code: String,
}

/// Either the gradients or the reason there are none. A rejection cannot cross
/// the boundary as a `Result`, so the façade reads `error` and throws — which is
/// what the TypeScript caller already expects.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GradientParseResult {
    pub gradients: Vec<GradientAst>,
    pub error: Option<String>,
}

#[export]
pub fn parse_gradient_value(
    GradientParseOptions { code }: GradientParseOptions,
) -> GradientParseResult {
    match parse_gradient(&code) {
        Ok(gradients) => GradientParseResult {
            gradients,
            error: None,
        },
        Err(error) => GradientParseResult {
            gradients: Vec::new(),
            error: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(code: &str) -> Vec<GradientAst> {
        parse_gradient(code).expect("expected the gradient to parse")
    }

    fn one(code: &str) -> GradientAst {
        let mut parsed = parse(code);
        assert_eq!(parsed.len(), 1, "expected exactly one gradient in {code:?}");
        parsed.remove(0)
    }

    fn percent(value: &str) -> GradientDistance {
        GradientDistance::Percent {
            value: value.to_owned(),
        }
    }

    fn hex(value: &str, length: Option<GradientDistance>) -> GradientColorStop {
        GradientColorStop::Hex {
            value: value.to_owned(),
            length,
        }
    }

    fn literal(value: &str, length: Option<GradientDistance>) -> GradientColorStop {
        GradientColorStop::Literal {
            value: value.to_owned(),
            length,
        }
    }

    fn position(x: Option<GradientDistance>, y: Option<GradientDistance>) -> GradientPosition {
        GradientPosition::Position {
            value: GradientPositionValue { x, y },
        }
    }

    #[test]
    fn every_gradient_type_is_recognised() {
        for (code, kind) in [
            ("linear-gradient(red, blue)", GradientKind::LinearGradient),
            (
                "repeating-linear-gradient(red, blue)",
                GradientKind::RepeatingLinearGradient,
            ),
            ("radial-gradient(red, blue)", GradientKind::RadialGradient),
            (
                "repeating-radial-gradient(red, blue)",
                GradientKind::RepeatingRadialGradient,
            ),
        ] {
            assert_eq!(one(code).kind, kind, "{code}");
        }
    }

    #[test]
    fn vendor_prefixes_are_accepted_and_dropped() {
        for prefix in ["-webkit-", "-o-", "-ms-", "-moz-"] {
            let code = format!("{prefix}linear-gradient(red, blue)");
            assert_eq!(one(&code).kind, GradientKind::LinearGradient, "{code}");
        }
        // A prefix with no gradient behind it cannot fall back to the bare name.
        assert!(parse_gradient("-webkit-nonsense(red, blue)").is_err());
    }

    #[test]
    fn a_gradient_with_no_orientation_has_none() {
        let ast = one("linear-gradient(red, blue)");
        assert_eq!(ast.orientation, None);
        assert_eq!(
            ast.color_stops,
            vec![literal("red", None), literal("blue", None)]
        );
    }

    #[test]
    fn directional_orientations_keep_the_whole_corner() {
        for (code, expected) in [
            ("linear-gradient(to left, red, blue)", "left"),
            ("linear-gradient(to left top, red, blue)", "left top"),
            (
                "linear-gradient(to bottom right, red, blue)",
                "bottom right",
            ),
            ("linear-gradient(TO RIGHT, red, blue)", "RIGHT"),
        ] {
            assert_eq!(
                one(code).orientation,
                Some(GradientOrientation::Linear(
                    GradientLinearOrientation::Directional {
                        value: expected.to_owned(),
                    }
                )),
                "{code}"
            );
        }
    }

    #[test]
    fn a_bare_side_keyword_is_the_legacy_direction() {
        assert_eq!(
            one("linear-gradient(top, red, blue)").orientation,
            Some(GradientOrientation::Linear(
                GradientLinearOrientation::Directional {
                    value: "top".to_owned(),
                }
            ))
        );
    }

    #[test]
    fn angular_orientations_drop_their_unit() {
        // A quirk carried over deliberately: `deg` and `rad` are
        // indistinguishable once parsed.
        for code in [
            "linear-gradient(45deg, red, blue)",
            "linear-gradient(45rad, red, blue)",
        ] {
            assert_eq!(
                one(code).orientation,
                Some(GradientOrientation::Linear(
                    GradientLinearOrientation::Angular {
                        value: "45".to_owned(),
                    }
                )),
                "{code}"
            );
        }
        assert_eq!(
            one("linear-gradient(-0.5deg, red, blue)").orientation,
            Some(GradientOrientation::Linear(
                GradientLinearOrientation::Angular {
                    value: "-0.5".to_owned(),
                }
            ))
        );
    }

    #[test]
    fn a_trailing_dot_still_reads_as_a_number() {
        // `12.deg` needs the engine to keep the dot rather than give it back.
        assert_eq!(
            one("linear-gradient(12.deg, red, blue)").orientation,
            Some(GradientOrientation::Linear(
                GradientLinearOrientation::Angular {
                    value: "12.".to_owned(),
                }
            ))
        );
    }

    #[test]
    fn radial_shapes_carry_their_style_and_position() {
        assert_eq!(
            one("radial-gradient(circle 20px, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::Shape {
                    value: GradientShapeValue::Circle,
                    style: Some(GradientShapeStyle::Distance(GradientDistance::Px {
                        value: "20".to_owned(),
                    })),
                    at: None,
                }
            ]))
        );

        assert_eq!(
            one("radial-gradient(ellipse closest-side at 30% 70%, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::Shape {
                    value: GradientShapeValue::Ellipse,
                    style: Some(GradientShapeStyle::ExtentKeyword(
                        GradientExtentKeyword::ExtentKeyword {
                            value: "closest-side".to_owned(),
                        }
                    )),
                    at: Some(position(Some(percent("30")), Some(percent("70")))),
                }
            ]))
        );
    }

    #[test]
    fn an_ellipse_with_one_distance_leaves_y_absent() {
        assert_eq!(
            one("radial-gradient(ellipse 50%, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::Shape {
                    value: GradientShapeValue::Ellipse,
                    style: Some(GradientShapeStyle::Position(position(
                        Some(percent("50")),
                        None
                    ))),
                    at: None,
                }
            ]))
        );
    }

    #[test]
    fn a_bare_extent_keyword_is_its_own_orientation() {
        assert_eq!(
            one("radial-gradient(farthest-corner, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::ExtentKeyword {
                    value: "farthest-corner".to_owned(),
                    at: None,
                }
            ]))
        );
        assert_eq!(
            one("radial-gradient(cover at center, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::ExtentKeyword {
                    value: "cover".to_owned(),
                    at: Some(position(
                        Some(GradientDistance::PositionKeyword {
                            value: "center".to_owned(),
                        }),
                        None
                    )),
                }
            ]))
        );
    }

    #[test]
    fn extent_keywords_are_case_sensitive() {
        // The only token in the table without an `i` flag, so `COVER` falls
        // through to the literal colour and the gradient is rejected for the
        // comma it then cannot find.
        assert!(parse_gradient("radial-gradient(COVER, red, blue)").is_ok());
        let ast = one("radial-gradient(COVER, red, blue)");
        assert_eq!(ast.orientation, None);
        assert_eq!(ast.color_stops.len(), 3);
    }

    #[test]
    fn two_lengths_and_an_at_clause_read_as_an_implicit_ellipse() {
        assert_eq!(
            one("radial-gradient(50% 60% at 10% 20%, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::Shape {
                    value: GradientShapeValue::Ellipse,
                    style: Some(GradientShapeStyle::Position(position(
                        Some(percent("50")),
                        Some(percent("60"))
                    ))),
                    at: Some(position(Some(percent("10")), Some(percent("20")))),
                }
            ]))
        );
    }

    #[test]
    fn a_lone_at_clause_is_a_default_radial() {
        assert_eq!(
            one("radial-gradient(at top left, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::DefaultRadial {
                    at: position(
                        Some(GradientDistance::PositionKeyword {
                            value: "top".to_owned(),
                        }),
                        Some(GradientDistance::PositionKeyword {
                            value: "left".to_owned(),
                        }),
                    ),
                }
            ]))
        );
    }

    #[test]
    fn a_bare_position_is_also_a_default_radial() {
        assert_eq!(
            one("radial-gradient(30px 40px, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::DefaultRadial {
                    at: position(
                        Some(GradientDistance::Px {
                            value: "30".to_owned(),
                        }),
                        Some(GradientDistance::Px {
                            value: "40".to_owned(),
                        }),
                    ),
                }
            ]))
        );
    }

    #[test]
    fn a_radial_orientation_list_holds_at_most_two_nodes() {
        assert_eq!(
            one("radial-gradient(circle, closest-side, red, blue)").orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::Shape {
                    value: GradientShapeValue::Circle,
                    style: None,
                    at: None,
                },
                GradientRadialOrientation::ExtentKeyword {
                    value: "closest-side".to_owned(),
                    at: None,
                },
            ]))
        );
    }

    #[test]
    fn the_comma_after_a_single_orientation_stays_for_the_stops() {
        // `red` is not a radial orientation, so the lookahead rewinds and the
        // comma introduces the colour stops instead.
        let ast = one("radial-gradient(circle, red, blue)");
        assert_eq!(
            ast.orientation,
            Some(GradientOrientation::Radial(vec![
                GradientRadialOrientation::Shape {
                    value: GradientShapeValue::Circle,
                    style: None,
                    at: None,
                }
            ]))
        );
        assert_eq!(
            ast.color_stops,
            vec![literal("red", None), literal("blue", None)]
        );
    }

    #[test]
    fn every_colour_notation_parses() {
        let ast = one(
            "linear-gradient(#fff, #A0B1C2FF, red, rgb(1, 2, 3), rgba(1, 2, 3, 0.5), \
             hsl(120, 50%, 25%), hsla(120, 50%, 25%, 0.5), var(--brand))",
        );
        assert_eq!(
            ast.color_stops,
            vec![
                hex("fff", None),
                hex("A0B1C2FF", None),
                literal("red", None),
                GradientColorStop::Rgb {
                    value: vec!["1".to_owned(), "2".to_owned(), "3".to_owned()],
                    length: None,
                },
                GradientColorStop::Rgba {
                    value: vec![
                        "1".to_owned(),
                        "2".to_owned(),
                        "3".to_owned(),
                        "0.5".to_owned()
                    ],
                    length: None,
                },
                GradientColorStop::Hsl {
                    value: vec!["120".to_owned(), "50".to_owned(), "25".to_owned()],
                    length: None,
                },
                GradientColorStop::Hsla {
                    value: vec![
                        "120".to_owned(),
                        "50".to_owned(),
                        "25".to_owned(),
                        "0.5".to_owned()
                    ],
                    length: None,
                },
                GradientColorStop::Var {
                    value: "--brand".to_owned(),
                    length: None,
                },
            ]
        );
    }

    #[test]
    fn a_var_fallback_stays_inside_the_name() {
        assert_eq!(
            one("linear-gradient(var(--brand, #fff), blue)").color_stops[0],
            GradientColorStop::Var {
                value: "--brand, #fff".to_owned(),
                length: None,
            }
        );
    }

    #[test]
    fn hsl_accepts_space_separated_components() {
        assert_eq!(
            one("linear-gradient(hsl(120 50% 25%), blue)").color_stops[0],
            GradientColorStop::Hsl {
                value: vec!["120".to_owned(), "50".to_owned(), "25".to_owned()],
                length: None,
            }
        );
    }

    #[test]
    fn stops_carry_lengths_in_every_unit() {
        let ast =
            one("linear-gradient(red 0%, blue 10px, green 2em, black calc(50% - 4px), white)");
        assert_eq!(
            ast.color_stops,
            vec![
                literal("red", Some(percent("0"))),
                literal(
                    "blue",
                    Some(GradientDistance::Px {
                        value: "10".to_owned(),
                    })
                ),
                literal(
                    "green",
                    Some(GradientDistance::Em {
                        value: "2".to_owned(),
                    })
                ),
                literal(
                    "black",
                    Some(GradientDistance::Calc {
                        value: "50% - 4px".to_owned(),
                    })
                ),
                literal("white", None),
            ]
        );
    }

    #[test]
    fn calc_bodies_may_nest() {
        assert_eq!(
            one("linear-gradient(red calc(100% - calc(2px + 1px)), blue)").color_stops[0],
            literal(
                "red",
                Some(GradientDistance::Calc {
                    value: "100% - calc(2px + 1px)".to_owned(),
                })
            )
        );
    }

    #[test]
    fn several_gradients_parse_as_a_list() {
        let parsed = parse("linear-gradient(red, blue), radial-gradient(green, black)");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].kind, GradientKind::LinearGradient);
        assert_eq!(parsed[1].kind, GradientKind::RadialGradient);
    }

    #[test]
    fn whitespace_and_a_trailing_semicolon_are_tolerated() {
        let ast = one("\n  linear-gradient( to left , red , blue ) ;  ");
        assert_eq!(
            ast.orientation,
            Some(GradientOrientation::Linear(
                GradientLinearOrientation::Directional {
                    value: "left".to_owned(),
                }
            ))
        );
        assert_eq!(ast.color_stops.len(), 2);
    }

    #[test]
    fn nothing_at_all_parses_to_an_empty_list() {
        assert_eq!(parse(""), Vec::new());
        assert_eq!(parse("   "), Vec::new());
    }

    #[test]
    fn malformed_input_is_rejected() {
        for code in [
            // Not a gradient, so the leftover input is not EOF.
            "not-a-gradient(red, blue)",
            // Missing parentheses.
            "linear-gradient red, blue)",
            "linear-gradient(red, blue",
            // No colour stops at all.
            "linear-gradient()",
            // A trailing comma in a stop list.
            "linear-gradient(red, blue,)",
            // An orientation with nothing after it.
            "linear-gradient(to left)",
            // A percentage hue.
            "linear-gradient(hsl(50%, 50%, 50%), blue)",
            // Saturation and lightness have to be percentages.
            "linear-gradient(hsl(120, 50, 25), blue)",
            // `hsla` needs four components.
            "linear-gradient(hsla(120, 50%, 25%), blue)",
            // `rgb` needs at least one number.
            "linear-gradient(rgb(), blue)",
            // A `var` with no custom property name.
            "linear-gradient(var(brand), blue)",
            // An unbalanced `calc`.
            "linear-gradient(red calc(100% - 4px, blue)",
            // Trailing junk after a complete gradient.
            "linear-gradient(red, blue) leftovers",
        ] {
            assert!(
                parse_gradient(code).is_err(),
                "expected {code:?} to be rejected"
            );
        }
    }

    #[test]
    fn an_at_clause_with_no_position_is_rejected() {
        // `/^at/` has no word boundary, so `atrocious` enters the branch and
        // then fails — the original does the same.
        assert!(parse_gradient("radial-gradient(at, red, blue)").is_err());
    }

    #[test]
    fn the_error_message_starts_with_what_is_left_of_the_input() {
        let error = parse_gradient("linear-gradient(red, blue) leftovers")
            .expect_err("expected trailing input to be rejected");
        assert_eq!(error, "leftovers: Invalid input not EOF");
    }

    #[test]
    fn number_candidates_follow_the_regex_preference_order() {
        assert_eq!(number_candidate_lengths("50%"), vec![2, 1]);
        assert_eq!(number_candidate_lengths("5."), vec![2, 1]);
        assert_eq!(number_candidate_lengths("5.5"), vec![3, 2, 1]);
        assert_eq!(number_candidate_lengths("12.34"), vec![5, 4, 3, 2, 1]);
        assert_eq!(number_candidate_lengths(".5"), vec![2]);
        assert!(number_candidate_lengths(".").is_empty());
        assert!(number_candidate_lengths("px").is_empty());
    }

    #[test]
    fn the_wire_shape_matches_the_typescript_ast() {
        let ast = one("radial-gradient(circle at center, #fff 0%, blue)");
        let json = serde_json::to_value(&ast).expect("the AST serialises");

        assert_eq!(
            json,
            serde_json::json!({
                "type": "radial-gradient",
                "orientation": [{
                    "type": "shape",
                    "value": "circle",
                    "style": null,
                    "at": {
                        "type": "position",
                        "value": {
                            "x": { "type": "position-keyword", "value": "center" },
                            "y": null,
                        },
                    },
                }],
                "colorStops": [
                    { "type": "hex", "value": "fff", "length": { "type": "%", "value": "0" } },
                    { "type": "literal", "value": "blue", "length": null },
                ],
            })
        );
    }

    #[test]
    fn an_extent_keyword_without_an_at_clause_omits_the_key() {
        // Unlike a shape, whose `style` and `at` are always written. `null` here
        // is `undefined` once it crosses to JavaScript, and the two objects have
        // different key sets on that side too.
        let ast = one("radial-gradient(cover, red, blue)");
        let json = serde_json::to_value(&ast).expect("the AST serialises");
        let orientation = &json["orientation"][0];

        assert_eq!(orientation["type"], "extent-keyword");
        assert!(orientation.get("at").is_none());
    }

    #[test]
    fn the_bridge_reports_a_rejection_instead_of_panicking() {
        let rejected = parse_gradient_value(GradientParseOptions {
            code: "not-a-gradient".to_owned(),
        });
        assert!(rejected.gradients.is_empty());
        assert_eq!(
            rejected.error.as_deref(),
            Some("not-a-gradient: Invalid input not EOF")
        );

        let accepted = parse_gradient_value(GradientParseOptions {
            code: "linear-gradient(red, blue)".to_owned(),
        });
        assert_eq!(accepted.error, None);
        assert_eq!(accepted.gradients.len(), 1);
    }
}
