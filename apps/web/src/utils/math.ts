import {
	clampRoundValue as _clampRoundValue,
	formatNumberForDisplayValue as _formatNumberForDisplayValue,
} from "bluper-wasm";

/**
 * Numeric helpers. `clampRound` and `formatNumberForDisplay` live in
 * `editor-core::math::display` — the latter because `toFixed` rounds
 * half-away-from-zero while Rust's `format!("{:.N}", …)` rounds half-to-even,
 * a difference that shows up on exact binary ties a slider lands on.
 */

export function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.max(min, Math.min(max, value));
}

export function clampRound({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return _clampRoundValue({ value, min, max });
}

export { getFractionDigitsForStep, snapToStep } from "@/wasm/params";

export function isNearlyEqual({
	leftValue,
	rightValue,
	epsilon = 0.0001,
}: {
	leftValue: number;
	rightValue: number;
	epsilon?: number;
}): boolean {
	return Math.abs(leftValue - rightValue) <= epsilon;
}

export function formatNumberForDisplay({
	value,
	fractionDigits,
	minFractionDigits = 0,
	maxFractionDigits = 6,
}: {
	value: number;
	fractionDigits?: number;
	minFractionDigits?: number;
	maxFractionDigits?: number;
}): string {
	return _formatNumberForDisplayValue({
		value,
		fractionDigits,
		minFractionDigits,
		maxFractionDigits,
	});
}

/**
 * Safely evaluates a mathematical expression without using eval() or new Function().
 * Supports +, -, *, /, parentheses, and decimal numbers.
 */
export function evaluateMathExpression({
	input,
}: {
	input: string;
}): number | null {
	const sanitized = input.trim();
	if (!/^[\d.\s+\-*/()]+$/.test(sanitized)) return null;
	try {
		return parseExpression(sanitized);
	} catch {
		return null;
	}
}

/**
 * Recursive descent parser for basic arithmetic expressions.
 * Grammar:
 *   expression = term { ('+' | '-') term }
 *   term = factor { ('*' | '/') factor }
 *   factor = number | '(' expression ')'
 */
function parseExpression(input: string): number | null {
	const tokens = tokenize(input);
	if (tokens.length === 0) return null;

	let index = 0;

	function peek(): Token | null {
		return tokens[index] ?? null;
	}

	function consume(): Token | null {
		return tokens[index++] ?? null;
	}

	function parseExpressionLevel(): number {
		let left = parseTerm();
		while (true) {
			const token = peek();
			if (token?.type === "PLUS") {
				consume();
				left = left + parseTerm();
			} else if (token?.type === "MINUS") {
				consume();
				left = left - parseTerm();
			} else {
				break;
			}
		}
		return left;
	}

	function parseTerm(): number {
		let left = parseFactor();
		while (true) {
			const token = peek();
			if (token?.type === "MULTIPLY") {
				consume();
				left = left * parseFactor();
			} else if (token?.type === "DIVIDE") {
				consume();
				const right = parseFactor();
				if (right === 0) throw new Error("Division by zero");
				left = left / right;
			} else {
				break;
			}
		}
		return left;
	}

	function parseFactor(): number {
		const token = peek();
		if (!token) throw new Error("Unexpected end of expression");

		if (token.type === "NUMBER") {
			consume();
			return token.value;
		}

		if (token.type === "MINUS") {
			consume();
			return -parseFactor();
		}

		if (token.type === "LPAREN") {
			consume();
			const value = parseExpressionLevel();
			const next = peek();
			if (next?.type !== "RPAREN") {
				throw new Error("Missing closing parenthesis");
			}
			consume();
			return value;
		}

		throw new Error(`Unexpected token: ${token.type}`);
	}

	const result = parseExpressionLevel();

	if (index !== tokens.length) {
		return null;
	}

	if (!Number.isFinite(result)) return null;
	return result;
}

type Token =
	| { type: "NUMBER"; value: number }
	| { type: "PLUS" }
	| { type: "MINUS" }
	| { type: "MULTIPLY" }
	| { type: "DIVIDE" }
	| { type: "LPAREN" }
	| { type: "RPAREN" };

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const str = input.trim();

	while (i < str.length) {
		const char = str[i];

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		if (/\d/.test(char)) {
			let numStr = "";
			while (i < str.length && (/\d/.test(str[i]) || str[i] === ".")) {
				numStr += str[i];
				i++;
			}
			const value = Number(numStr);
			if (!Number.isFinite(value)) {
				throw new Error(`Invalid number: ${numStr}`);
			}
			tokens.push({ type: "NUMBER", value });
			continue;
		}

		switch (char) {
			case "+":
				tokens.push({ type: "PLUS" });
				break;
			case "-":
				tokens.push({ type: "MINUS" });
				break;
			case "*":
				tokens.push({ type: "MULTIPLY" });
				break;
			case "/":
				tokens.push({ type: "DIVIDE" });
				break;
			case "(":
				tokens.push({ type: "LPAREN" });
				break;
			case ")":
				tokens.push({ type: "RPAREN" });
				break;
			default:
				throw new Error(`Invalid character: ${char}`);
		}
		i++;
	}

	return tokens;
}
