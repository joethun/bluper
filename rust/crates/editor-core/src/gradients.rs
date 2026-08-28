//! CSS gradient parsing.

mod parser;

pub use parser::{
    GradientAst, GradientColor, GradientColorStop, GradientDistance, GradientExtentKeyword,
    GradientKind, GradientLinearOrientation, GradientOrientation, GradientParseOptions,
    GradientParseResult, GradientPosition, GradientPositionValue, GradientRadialOrientation,
    GradientShapeStyle, GradientShapeValue, parse_gradient, parse_gradient_value,
};
