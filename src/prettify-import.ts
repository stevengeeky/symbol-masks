/**
 * Pure conversion of `prettifySymbolsMode.substitutions`
 * (siegebell.prettify-symbols-mode) into `symbolMasks.masks`.
 *
 * This module must not import vscode so it can be unit tested with plain node.
 *
 * prettify-symbols-mode builds each rule as the regex
 *     (?:pre)(ugly)(?:post)
 * matched line by line, where `pre` and `post` are consumed context.
 * Symbol Masks matches one regex against the whole document, so the
 * context becomes a lookbehind/lookahead and line anchors (^ $) turn
 * on the multiline flag.
 */

/** A prettify-symbols-mode style (mirrors its PrettyStyleProperties) */
export interface PrettifyStyleProperties {
	border?: string;
	textDecoration?: string;
	color?: string | { id: string };
	backgroundColor?: string | { id: string };
	hackCSS?: string;
}

export interface PrettifyStyle extends PrettifyStyleProperties {
	dark?: PrettifyStyleProperties;
	light?: PrettifyStyleProperties;
}

/** One prettify-symbols-mode substitution */
export interface PrettifySubstitution {
	ugly: string;
	pretty?: string;
	pre?: string;
	post?: string;
	style?: PrettifyStyle;
	scope?: string;
}

/** One prettify-symbols-mode language entry */
export interface PrettifyLanguageEntry {
	language: unknown;
	substitutions: PrettifySubstitution[];
	[other: string]: unknown;
}

/** The style block of a Symbol Masks pattern */
export interface MaskStyle {
	backgroundColor?: string;
	border?: string;
	borderColor?: string;
	color?: string;
	fontStyle?: string;
	fontWeight?: string;
	css?: string;
}

/** One entry of a match based replace */
export interface MaskReplaceEntry extends MaskStyle {
	text: string;
	scope?: string;
}

/** One Symbol Masks pattern */
export interface MaskPattern {
	pattern: string;
	ignoreCase?: boolean;
	multiline?: boolean;
	replace?: string | { [match: string]: MaskReplaceEntry };
	scope?: string;
	style?: MaskStyle;
}

/** One element of `symbolMasks.masks` */
export interface SymbolMask {
	language: unknown;
	patterns: MaskPattern[];
}

export interface ConversionResult {
	masks: SymbolMask[];
	/** Human readable notes about anything that could not be carried over 1:1 */
	warnings: string[];
	/** How many prettify substitutions were read */
	substitutionCount: number;
	/** How many Symbol Masks patterns were produced */
	patternCount: number;
}

/** Characters that mean something special when unescaped */
const REGEX_META = /[\\^$.|?*+()[\]{}]/;
/** Characters which stand for themselves when escaped (\- and \/ included) */
const REGEX_ESCAPED_LITERAL = /[\\^$.|?*+()[\]{}\/-]/;

/**
 * Escape a literal string for use inside a regex
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/**
 * If a regex source can only ever match one fixed string, return that
 * string; otherwise return null. Used to fold many literal symbols into
 * a single match based replace pattern.
 */
export function regexLiteral(source: string): string | null {
	let literal = "";
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) {
				return null;
			}
			if (REGEX_ESCAPED_LITERAL.test(next)) {
				literal += next;
				i++;
				continue;
			}
			// \d \w \s \b \n \u.... : not a plain character
			return null;
		}
		if (REGEX_META.test(ch)) {
			return null;
		}
		literal += ch;
	}
	return literal.length > 0 ? literal : null;
}

/**
 * Whether a regex source uses ^ or $ as anchors
 * (ignoring escaped ones and ^ inside a character class)
 */
export function usesLineAnchors(source: string): boolean {
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (inClass) {
			if (ch === "]") {
				inClass = false;
			}
			continue;
		}
		if (ch === "[") {
			inClass = true;
			continue;
		}
		if (ch === "^" || ch === "$") {
			return true;
		}
	}
	return false;
}

/**
 * Build the Symbol Masks regex source for a substitution
 */
export function buildPattern(ugly: string, pre?: string, post?: string): string {
	let pattern = `(?:${ugly})`;
	if (pre) {
		pattern = `(?<=(?:${pre}))` + pattern;
	}
	if (post) {
		pattern += `(?=(?:${post}))`;
	}
	return pattern;
}

/**
 * Translate a prettify style into a Symbol Masks style
 */
export function convertStyle(style: PrettifyStyle | undefined, where: string, warnings: string[]): MaskStyle | undefined {
	if (!style || typeof style !== "object") {
		return undefined;
	}
	const result: MaskStyle = {};
	const colorOf = (value: string | { id: string } | undefined, name: string) => {
		if (value === undefined) {
			return undefined;
		}
		if (typeof value === "string") {
			return value;
		}
		warnings.push(`${where}: theme colour ${name} ${JSON.stringify(value)} is not supported and was dropped`);
		return undefined;
	};
	const color = colorOf(style.color, "color");
	const backgroundColor = colorOf(style.backgroundColor, "backgroundColor");
	if (color !== undefined) {
		result.color = color;
	}
	if (backgroundColor !== undefined) {
		result.backgroundColor = backgroundColor;
	}
	if (style.border) {
		result.border = style.border;
	}
	const css: string[] = [];
	if (style.textDecoration) {
		css.push(`text-decoration: ${style.textDecoration}`);
	}
	if (style.hackCSS) {
		css.push(style.hackCSS);
	}
	if (css.length) {
		result.css = css.join("; ");
	}
	if (style.dark || style.light) {
		warnings.push(`${where}: light/dark theme specific styles are not supported and were dropped`);
	}
	return Object.keys(result).length ? result : undefined;
}

interface Group {
	key: string;
	pre?: string;
	post?: string;
	scope?: string;
	style?: MaskStyle;
	/** literal ugly text => entry, in order of first appearance */
	entries: Map<string, MaskReplaceEntry>;
}

/**
 * Convert the whole `prettifySymbolsMode.substitutions` array
 */
export function convertPrettifySymbols(entries: unknown): ConversionResult {
	const result: ConversionResult = { masks: [], warnings: [], substitutionCount: 0, patternCount: 0 };
	if (!Array.isArray(entries)) {
		result.warnings.push("prettifySymbolsMode.substitutions is not an array; nothing to import");
		return result;
	}

	entries.forEach((entry: any, entryIndex: number) => {
		const where = `entry ${entryIndex + 1}`;
		if (!entry || typeof entry !== "object") {
			result.warnings.push(`${where}: not an object, skipped`);
			return;
		}
		if (entry.language === undefined || entry.language === null) {
			result.warnings.push(`${where}: has no "language", skipped`);
			return;
		}
		if (!Array.isArray(entry.substitutions)) {
			result.warnings.push(`${where} (${JSON.stringify(entry.language)}): has no "substitutions" array, skipped`);
			return;
		}

		// Patterns are emitted in order of first appearance; a group is
		// a slot in this list that several literal substitutions share
		const slots: Array<MaskPattern | Group> = [];
		const groups = new Map<string, Group>();

		entry.substitutions.forEach((subst: any, substIndex: number) => {
			const label = `${where} (${JSON.stringify(entry.language)}) substitution ${substIndex + 1}`;
			if (!subst || typeof subst !== "object" || typeof subst.ugly !== "string" || subst.ugly.length === 0) {
				result.warnings.push(`${label}: has no "ugly" string, skipped`);
				return;
			}
			result.substitutionCount++;

			const pretty = typeof subst.pretty === "string" && subst.pretty.length > 0 ? subst.pretty : undefined;
			const pre = typeof subst.pre === "string" && subst.pre.length > 0 ? subst.pre : undefined;
			const post = typeof subst.post === "string" && subst.post.length > 0 ? subst.post : undefined;
			const scope = typeof subst.scope === "string" && subst.scope.length > 0 ? subst.scope : undefined;
			const style = convertStyle(subst.style, label, result.warnings);

			if (!pretty && !style) {
				result.warnings.push(`${label} (${JSON.stringify(subst.ugly)}): has neither "pretty" nor "style", skipped`);
				return;
			}

			const multiline = usesLineAnchors((pre || "") + subst.ugly + (post || "")) || undefined;
			const source = buildPattern(subst.ugly, pre, post);
			let regex: RegExp;
			try {
				regex = new RegExp(source, "g" + (multiline ? "m" : ""));
			} catch (err) {
				result.warnings.push(`${label} (${JSON.stringify(subst.ugly)}): invalid regular expression, skipped: ${err}`);
				return;
			}
			if (regex.test("")) {
				result.warnings.push(`${label} (${JSON.stringify(subst.ugly)}): matches the empty string, skipped`);
				return;
			}

			const literal = pretty ? regexLiteral(subst.ugly) : null;
			if (literal !== null && pretty) {
				const key = JSON.stringify([pre || "", post || "", scope || "", style || null]);
				let group = groups.get(key);
				if (!group) {
					group = { key, pre, post, scope, style, entries: new Map() };
					groups.set(key, group);
					slots.push(group);
				}
				if (group.entries.has(literal)) {
					result.warnings.push(`${label}: ${JSON.stringify(subst.ugly)} was already given a replacement in this language; the first one wins`);
					return;
				}
				group.entries.set(literal, Object.assign({ text: pretty }, style || {}));
				return;
			}

			const pattern: MaskPattern = { pattern: source };
			if (multiline) {
				pattern.multiline = true;
			}
			if (pretty) {
				pattern.replace = pretty;
			}
			if (scope) {
				pattern.scope = scope;
			}
			if (style) {
				pattern.style = style;
			}
			slots.push(pattern);
		});

		const patterns: MaskPattern[] = [];
		for (const slot of slots) {
			if ("entries" in slot) {
				patterns.push(groupToPattern(slot));
			} else {
				patterns.push(slot);
			}
		}
		if (patterns.length === 0) {
			result.warnings.push(`${where} (${JSON.stringify(entry.language)}): produced no patterns`);
			return;
		}
		result.patternCount += patterns.length;
		result.masks.push({ language: entry.language, patterns });
	});

	return result;
}

/**
 * Turn a group of literal substitutions into one pattern: a single
 * literal becomes a plain string replace, several become a match
 * based replace (longest literal first, so `===` wins over `==`)
 */
function groupToPattern(group: Group): MaskPattern {
	const literals = Array.from(group.entries.keys());
	literals.sort((a, b) => b.length - a.length);
	const alternation = literals.map(escapeRegExp).join("|");
	const source = buildPattern(alternation, group.pre, group.post);
	const pattern: MaskPattern = { pattern: source };
	if (usesLineAnchors((group.pre || "") + (group.post || ""))) {
		pattern.multiline = true;
	}
	if (literals.length === 1) {
		const only = group.entries.get(literals[0])!;
		pattern.replace = only.text;
		if (group.scope) {
			pattern.scope = group.scope;
		}
		if (group.style) {
			pattern.style = group.style;
		}
		return pattern;
	}
	const replace: { [match: string]: MaskReplaceEntry } = {};
	for (const literal of literals) {
		replace[literal] = group.entries.get(literal)!;
	}
	pattern.replace = replace;
	if (group.scope) {
		pattern.scope = group.scope;
	}
	return pattern;
}
