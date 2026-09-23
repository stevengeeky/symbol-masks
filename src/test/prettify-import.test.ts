/**
 * Unit tests for the prettify-symbols-mode converter.
 * Plain node, no vscode: `npm test`
 */
import * as assert from "assert";
import {
	convertPrettifySymbols,
	regexLiteral,
	escapeRegExp,
	usesLineAnchors,
	buildPattern,
	convertStyle,
	MaskPattern
} from "../prettify-import";

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

/** Convert one language's substitutions and return its patterns */
const patternsOf = (substitutions: any[], language: any = "plaintext") =>
	convertPrettifySymbols([{ language, substitutions }]);

/** Run a converted pattern over text and return the matched strings */
const matchesOf = (pattern: MaskPattern, text: string) => {
	const regex = new RegExp(pattern.pattern, "g" + (pattern.multiline ? "m" : ""));
	const found: string[] = [];
	let match: RegExpExecArray | null;
	while (match = regex.exec(text)) {
		if (match[0].length === 0) {
			break;
		}
		found.push(match[0]);
	}
	return found;
};

// --- helpers -------------------------------------------------------------

test("regexLiteral: plain text and escaped metacharacters are literal", () => {
	assert.strictEqual(regexLiteral("->"), "->");
	assert.strictEqual(regexLiteral("\\|\\|"), "||");
	assert.strictEqual(regexLiteral("\\\\"), "\\");
	assert.strictEqual(regexLiteral("List\\.mem"), "List.mem");
	assert.strictEqual(regexLiteral("a/b-c"), "a/b-c");
});

test("regexLiteral: real regexes are not literal", () => {
	assert.strictEqual(regexLiteral("List[.]mem"), null);
	assert.strictEqual(regexLiteral("not\\s?"), null);
	assert.strictEqual(regexLiteral("\\bfun\\b"), null);
	assert.strictEqual(regexLiteral("a|b"), null);
	assert.strictEqual(regexLiteral(".+"), null);
	assert.strictEqual(regexLiteral(""), null);
	assert.strictEqual(regexLiteral("trailing\\"), null);
});

test("escapeRegExp round-trips through regexLiteral", () => {
	for (const text of ["->", "||", "a.b", "(x)", "[y]", "a{2}", "^$", "$$"]) {
		assert.strictEqual(regexLiteral(escapeRegExp(text)), text);
		assert.ok(new RegExp(escapeRegExp(text)).test(text));
	}
});

test("usesLineAnchors: anchors only count when unescaped and outside classes", () => {
	assert.strictEqual(usesLineAnchors("^\\s+"), true);
	assert.strictEqual(usesLineAnchors("[^=<>]|$"), true);
	assert.strictEqual(usesLineAnchors("[^=<>]"), false);
	assert.strictEqual(usesLineAnchors("\\^\\$"), false);
	assert.strictEqual(usesLineAnchors("[$]"), false);
	assert.strictEqual(usesLineAnchors("->"), false);
});

test("buildPattern: pre/post become non-consuming lookarounds", () => {
	assert.strictEqual(buildPattern("->"), "(?:->)");
	assert.strictEqual(buildPattern("fun", "\\b", "\\b"), "(?<=(?:\\b))(?:fun)(?=(?:\\b))");
	assert.strictEqual(buildPattern("x", undefined, "$"), "(?:x)(?=(?:$))");
	assert.strictEqual(buildPattern("x", "^"), "(?<=(?:^))(?:x)");
});

test("convertStyle: maps the prettify style subset", () => {
	const warnings: string[] = [];
	const style = convertStyle({
		color: "red",
		backgroundColor: "#00000020",
		border: "1pt solid green",
		textDecoration: "underline",
		hackCSS: "font-style: italic"
	}, "t", warnings);
	assert.deepStrictEqual(style, {
		color: "red",
		backgroundColor: "#00000020",
		border: "1pt solid green",
		css: "text-decoration: underline; font-style: italic"
	});
	assert.deepStrictEqual(warnings, []);
});

test("convertStyle: theme colours and light/dark blocks are dropped with a warning", () => {
	const warnings: string[] = [];
	const style = convertStyle({ color: { id: "editor.foreground" }, dark: { color: "white" }, border: "1px" }, "t", warnings);
	assert.deepStrictEqual(style, { border: "1px" });
	assert.strictEqual(warnings.length, 2);
	assert.strictEqual(convertStyle({}, "t", warnings), undefined);
	assert.strictEqual(convertStyle(undefined, "t", warnings), undefined);
});

// --- whole conversions ---------------------------------------------------

test("a single literal substitution becomes a plain string replace", () => {
	const { masks, warnings, substitutionCount, patternCount } = patternsOf([{ ugly: "->", pretty: "→" }]);
	assert.deepStrictEqual(masks, [{ language: "plaintext", patterns: [{ pattern: "(?:->)", replace: "→" }] }]);
	assert.deepStrictEqual(warnings, []);
	assert.strictEqual(substitutionCount, 1);
	assert.strictEqual(patternCount, 1);
});

test("language selectors pass through untouched", () => {
	const selectors = ["fsharp", ["ocaml", { pattern: "**/*.ml" }], { language: "coq", scheme: "file" }];
	for (const language of selectors) {
		const { masks } = patternsOf([{ ugly: "->", pretty: "→" }], language);
		assert.deepStrictEqual(masks[0].language, language);
	}
});

test("pre/post word boundaries wrap the symbol in lookarounds that really guard it", () => {
	const { masks } = patternsOf([{ ugly: "fun", pretty: "λ", pre: "\\b", post: "\\b" }]);
	const [pattern] = masks[0].patterns;
	assert.strictEqual(pattern.pattern, "(?<=(?:\\b))(?:fun)(?=(?:\\b))");
	assert.strictEqual(pattern.multiline, undefined);
	assert.deepStrictEqual(matchesOf(pattern, "let f = fun x -> function y"), ["fun"]);
});

test("alternating pre/post with ^ and $ turn on multiline and behave per line", () => {
	const { masks } = patternsOf([
		{ ugly: ">=", pretty: "≥", pre: "[^=\\-<>]|^", post: "[^=\\-<>]|$" }
	]);
	const [pattern] = masks[0].patterns;
	assert.strictEqual(pattern.multiline, true);
	assert.deepStrictEqual(matchesOf(pattern, ">= a\nb >=\nc >== d\ne >= f"), [">=", ">=", ">="]);
});

test("a ^ only inside a character class does not turn on multiline", () => {
	const { masks } = patternsOf([{ ugly: "->", pretty: "→", pre: "[^->]", post: "[^->]" }]);
	assert.strictEqual(masks[0].patterns[0].multiline, undefined);
	assert.deepStrictEqual(matchesOf(masks[0].patterns[0], "a -> b --> c"), ["->"]);
});

test("regex uglies stay regexes and get their own pattern each", () => {
	const { masks } = patternsOf([
		{ ugly: "List[.]for_all", pretty: "∀", pre: "\\b", post: "\\b" },
		{ ugly: "not\\s?", pretty: "¬", pre: "\\b", post: "\\b" }
	]);
	assert.strictEqual(masks[0].patterns.length, 2);
	assert.deepStrictEqual(masks[0].patterns[0], {
		pattern: "(?<=(?:\\b))(?:List[.]for_all)(?=(?:\\b))",
		replace: "∀"
	});
	assert.deepStrictEqual(matchesOf(masks[0].patterns[0], "List.for_all f xs"), ["List.for_all"]);
	assert.deepStrictEqual(matchesOf(masks[0].patterns[1], "if not x then not(y)"), ["not ", "not"]);
});

test("an escaped literal is unescaped for the replace key and re-escaped in the pattern", () => {
	const { masks } = patternsOf([{ ugly: "\\|", pretty: "║", pre: "^\\s+" }]);
	const [pattern] = masks[0].patterns;
	assert.deepStrictEqual(pattern, { pattern: "(?<=(?:^\\s+))(?:\\|)", multiline: true, replace: "║" });
	assert.deepStrictEqual(matchesOf(pattern, "match x with\n  | A -> 1\n  | B -> 2"), ["|", "|"]);
});

test("literals sharing the same context fold into one match based pattern, longest first", () => {
	const { masks, patternCount } = patternsOf([
		{ ugly: "==", pretty: "≡" },
		{ ugly: "->", pretty: "→" },
		{ ugly: "===", pretty: "≣" },
		{ ugly: "\\|\\|", pretty: "∨" }
	]);
	assert.strictEqual(patternCount, 1);
	const [pattern] = masks[0].patterns;
	assert.strictEqual(pattern.pattern, "(?:===|==|->|\\|\\|)");
	assert.deepStrictEqual(pattern.replace, {
		"===": { text: "≣" },
		"==": { text: "≡" },
		"->": { text: "→" },
		"||": { text: "∨" }
	});
	const found = matchesOf(pattern, "a == b === c -> d || e");
	assert.deepStrictEqual(found, ["==", "===", "->", "||"]);
	for (const match of found) {
		assert.ok(match in (pattern.replace as object), `${match} has a replace entry`);
	}
});

test("different contexts make different groups, in order of first appearance", () => {
	const { masks } = patternsOf([
		{ ugly: "fun", pretty: "λ", pre: "\\b", post: "\\b" },
		{ ugly: "->", pretty: "→" },
		{ ugly: "rec", pretty: "μ", pre: "\\b", post: "\\b" },
		{ ugly: "<-", pretty: "←" }
	]);
	assert.strictEqual(masks[0].patterns.length, 2);
	assert.strictEqual(masks[0].patterns[0].pattern, "(?<=(?:\\b))(?:fun|rec)(?=(?:\\b))");
	assert.strictEqual(masks[0].patterns[1].pattern, "(?:->|<-)");
});

test("scope goes on the pattern and splits groups", () => {
	const { masks } = patternsOf([
		{ ugly: "fun", pretty: "λ", scope: "keyword.other.function-definition.fsharp" },
		{ ugly: "not", pretty: "¬", scope: "keyword.other" },
		{ ugly: "and", pretty: "∧", scope: "keyword.other" }
	]);
	assert.deepStrictEqual(masks[0].patterns, [
		{ pattern: "(?:fun)", replace: "λ", scope: "keyword.other.function-definition.fsharp" },
		{ pattern: "(?:not|and)", replace: { not: { text: "¬" }, and: { text: "∧" } }, scope: "keyword.other" }
	]);
});

test("styles ride along: on the pattern for a single, per key when grouped", () => {
	const { masks } = patternsOf([
		{ ugly: "TODO", pretty: "☐", style: { color: "orange" } },
		{ ugly: "DONE", pretty: "☑", style: { color: "orange" } },
		{ ugly: "FIXME", pretty: "‼", style: { color: "red", textDecoration: "underline" } }
	]);
	assert.deepStrictEqual(masks[0].patterns, [
		{ pattern: "(?:TODO|DONE)", replace: { TODO: { text: "☐", color: "orange" }, DONE: { text: "☑", color: "orange" } } },
		{ pattern: "(?:FIXME)", replace: "‼", style: { color: "red", css: "text-decoration: underline" } }
	]);
	const grouped = masks[0].patterns.find(p => typeof p.replace === "object")!;
	assert.deepStrictEqual(grouped.replace, { TODO: { text: "☐", color: "orange" }, DONE: { text: "☑", color: "orange" } });
	const single = masks[0].patterns.find(p => typeof p.replace === "string")!;
	assert.deepStrictEqual(single.style, { color: "red", css: "text-decoration: underline" });
});

test("a style-only substitution (no pretty) keeps the text and only styles it", () => {
	const { masks } = patternsOf([
		{ ugly: ".+", scope: "variable.parameter.fsharp", pre: "^", post: "$", style: { border: "1pt solid green" } }
	]);
	assert.deepStrictEqual(masks[0].patterns, [{
		pattern: "(?<=(?:^))(?:.+)(?=(?:$))",
		multiline: true,
		scope: "variable.parameter.fsharp",
		style: { border: "1pt solid green" }
	}]);
});

test("substitutions with neither pretty nor style are skipped with a warning", () => {
	const { masks, warnings, substitutionCount } = patternsOf([{ ugly: "x" }, { ugly: "y", pretty: "" }]);
	assert.deepStrictEqual(masks, []);
	assert.strictEqual(substitutionCount, 2);
	assert.strictEqual(warnings.length, 3); // two skips + "produced no patterns"
});

test("invalid regexes and empty-string matchers are skipped with a warning", () => {
	const { masks, warnings } = patternsOf([
		{ ugly: "(", pretty: "x" },
		{ ugly: "a*", pretty: "y" },
		{ ugly: "ok", pretty: "z" }
	]);
	assert.deepStrictEqual(masks[0].patterns, [{ pattern: "(?:ok)", replace: "z" }]);
	assert.strictEqual(warnings.length, 2);
	assert.ok(/invalid regular expression/.test(warnings[0]));
	assert.ok(/empty string/.test(warnings[1]));
});

test("a literal given twice keeps the first replacement, like prettify-symbols-mode", () => {
	const { masks, warnings } = patternsOf([{ ugly: "->", pretty: "→" }, { ugly: "->", pretty: "⟶" }]);
	assert.deepStrictEqual(masks[0].patterns, [{ pattern: "(?:->)", replace: "→" }]);
	assert.strictEqual(warnings.length, 1);
});

test("malformed entries are reported, not thrown", () => {
	const { masks, warnings } = convertPrettifySymbols([
		null,
		{ substitutions: [] },
		{ language: "x" },
		{ language: "y", substitutions: [null, { pretty: "no ugly" }, { ugly: "", pretty: "empty" }] }
	]);
	assert.deepStrictEqual(masks, []);
	assert.strictEqual(warnings.length, 7);
});

test("a non-array setting yields an empty result with a warning", () => {
	for (const input of [undefined, null, "nope", { language: "x", substitutions: [] }]) {
		const { masks, warnings } = convertPrettifySymbols(input);
		assert.deepStrictEqual(masks, []);
		assert.strictEqual(warnings.length, 1);
	}
});

test("the README example of prettify-symbols-mode converts without warnings", () => {
	const example = [{
		language: "coq",
		substitutions: [
			{ ugly: "\\\\", pretty: "λ", post: "\\s*(?:\\w|_).*?\\s*->" },
			{ ugly: "->", pretty: "→" },
			{ ugly: "==", pretty: "≡" },
			{ ugly: "not\\s?", pretty: "¬", pre: "\\b", post: "\\b" },
			{ ugly: ">", pretty: ">", pre: "[^=\\-<>]|^", post: "[^=\\-<>]|$" },
			{ ugly: "<", pretty: "<", pre: "[^=\\-<>]|^", post: "[^=\\-<>]|$" },
			{ ugly: ">=", pretty: "≥", pre: "[^=\\-<>]|^", post: "[^=\\-<>]|$" },
			{ ugly: "<=", pretty: "≤", pre: "[^=\\-<>]|^", post: "[^=\\-<>]|$" }
		]
	}, {
		language: ["ocaml", { pattern: "**/*.{ml}" }],
		revealOn: "none",
		substitutions: [
			{ ugly: "fun", pretty: "λ", pre: "\\b", post: "\\b" },
			{ ugly: "->", pretty: "→", pre: "[^->]", post: "[^->]" },
			{ ugly: "List[.]for_all", pretty: "∀", pre: "\\b", post: "\\b" },
			{ ugly: "List[.]exists", pretty: "∃", pre: "\\b", post: "\\b" },
			{ ugly: "List[.]mem", pretty: "∈", pre: "\\b", post: "\\b" },
			{ ugly: "\\|", pretty: "║", pre: "^\\s+" }
		]
	}];
	const { masks, warnings, substitutionCount, patternCount } = convertPrettifySymbols(example);
	assert.deepStrictEqual(warnings, []);
	assert.strictEqual(substitutionCount, 14);
	assert.strictEqual(masks.length, 2);
	// coq: [\\ | -> == | not | > < >= <=] => 4 patterns; ocaml: [fun | -> | 3 regexes | \|] => 6
	assert.strictEqual(patternCount, 10);
	const comparisons = masks[0].patterns[3];
	assert.strictEqual(comparisons.pattern, "(?<=(?:[^=\\-<>]|^))(?:>=|<=|>|<)(?=(?:[^=\\-<>]|$))");
	assert.deepStrictEqual(matchesOf(comparisons, "a >= b\n<= c\nd -> e < f"), [">=", "<=", "<"]);
	for (const mask of masks) {
		for (const pattern of mask.patterns) {
			assert.doesNotThrow(() => new RegExp(pattern.pattern, "g" + (pattern.multiline ? "m" : "")));
		}
	}
});

// --- runner --------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failed++;
		console.log(`  FAIL ${name}`);
		console.log(String(err && (err as Error).stack || err).split("\n").map(l => "       " + l).join("\n"));
	}
}
console.log(`\n${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed ? 1 : 0);
