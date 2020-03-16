import * as vscode from "vscode";
import ScopedDocument from "./scoped-document";

/**
 * An alternative to passing in a string
 * to match.text. A match based replace
 * is much more efficient in many
 * cases
 *
 * Also many of the complex regex match
 * cases can be resolved by simply utilizing
 * the scope instead. i.e.:
 *
 * "pattern": "\\[|\\]|<|>|!==|!=|===|==|=>|>=|<=|\\&\\&|\\|\\|"
 *
 * with
 * "<": {
 *		"scope": "punctuation.definition.typeparameters",
 *		"value": "⟨"
 *	},
 * No extra match information is needed in the regex, i.e. (?<=[\\s\\b])
 * because that complexity is handled by the grammar which generates
 * the scopes.
 */
interface MatchBasedReplace {
	[match: string]: {
		scope?: string,
		text: string,
		hover?: string,
		backgroundColor?: string,
		border?: string,
		borderColor?: string,
		color?: string,
		fontStyle?: string,
		fontWeight?: string,
		css?: string
	}
}

export interface Mask {
	/**
	 * The text to display in place of the
	 * original symbol
	 */
	text?: string | MatchBasedReplace
	/**
	 * The textmate grammar scope that these decorations
	 * should apply to
	 */
	scope?: string,
	/**
	 * The text to show when the decorator is hovered over
	 */
	hover?: string,
	/**
	 * backgroundColor CSS value
	 * for the new symbol
	 */
	backgroundColor?: string
	/**
	 * border CSS value for the new symbol
	 */
	border?: string
	/**
	 * borderColor CSS value for the new symbol
	 */
	borderColor?: string
	/**
	 * color CSS value for the new symbol
	 */
	color?: string
	/**
	 * fontStyle CSS value for the new symbol
	 */
	fontStyle?: string
	/**
	 * fontWeight CSS value for the new symbol
	 */
	fontWeight?: string
	/**
	 * Custom CSS to inject into the mask
	 */
	css?: string
}

/**
 * A class for creating and applying masks to a document
 */
export default class MaskController {
	private decorationTypeMap: Map<string, vscode.TextEditorDecorationType>;

	private scopedDocument: ScopedDocument | null;

	private editor: vscode.TextEditor | undefined;

	constructor(editor?: vscode.TextEditor, scopedDocument?: ScopedDocument) {
		this.editor = editor;
		this.scopedDocument = scopedDocument || null;
		this.decorationTypeMap = new Map();
	}

	public setScopedDocument(scopedDocument?: ScopedDocument | null) {
		this.scopedDocument = scopedDocument || null;
	}

	public getEditor() {
		return this.editor;
	}

	public setEditor(editor?: vscode.TextEditor) {
		this.editor = editor;
	}

	/**
	 * Clear all existing masks
	 */
	public clear () {
		if (this.editor) {
			for (const key of this.decorationTypeMap.keys()) {
				const decorationType = this.decorationTypeMap.get(key);
				if (decorationType) {
					this.editor.setDecorations(decorationType, []);
				}
			}
		}
		this.decorationTypeMap.clear();
	}

	/**
	 * Initialize new decorations to render on the document
	 */
	private initialize(id: string, mask: Mask) {
		if (!this.decorationTypeMap.has(id)) {
			this.decorationTypeMap.set(id, vscode.window.createTextEditorDecorationType({
				// Hide the actual character
				textDecoration: mask.text ? `none; display: none` : "none",
				backgroundColor: mask.backgroundColor,
				border: mask.border,
				borderColor: mask.borderColor,
				color: mask.color,
				fontStyle: mask.fontStyle,
				fontWeight: mask.fontWeight + (mask.css ? ";" + mask.css : ""),
				before: {
					// Render the mask text if provided
					contentText: typeof mask.text === "string" ? mask.text : undefined,
					backgroundColor: mask.backgroundColor,
					border: mask.border,
					borderColor: mask.borderColor,
					color: mask.color,
					fontStyle: mask.fontStyle,
					fontWeight: mask.fontWeight + (mask.css ? ";" + mask.css : "")
				}
			}));
		}
	}

	/**
	 * Decorate all matches of a given pattern with the given mask
	 * @param pattern The pattern to match
	 * @param mask The mask to apply to all matches of the given pattern
	 */
	public apply(pattern: RegExp, mask: Mask) {
		if (!this.editor) {
			return;
		}

		if (!this.decorationTypeMap.has(pattern.source)) {
			this.initialize(pattern.source, mask);
		}

		const text = this.editor.document.getText();
		const decorationOptions: Map<string, vscode.DecorationOptions[]> = new Map();
		const matchReplaceKeys: Set<string> = new Set();

		// The block and underline style cursors disappear one character before
		// the decorated mask, so styling is removed one character early for them
		const cursorStyle: string = vscode.workspace.getConfiguration().get("editor.cursorStyle") || "";

		let match: RegExpExecArray | null;
		while (match = pattern.exec(text)) {
			if (match[0].length === 0) {
				break;
			}
			const startPos = this.editor.document.positionAt(match.index);
			const endPos = this.editor.document.positionAt(match.index + match[0].length);

			let decorateSymbol = false;

			// Detect if there is a match based replacement
			let matchReplace: MatchBasedReplace[keyof MatchBasedReplace] | undefined;
			if (mask.text && typeof mask.text !== "string") {
				if (match[0] in mask.text) {
					matchReplace = mask.text[match[0]];
				}
			}

			// For all carets
			for (const selection of this.editor.selections) {
				let selectionStart = this.editor.document.offsetAt(selection.start);
				let selectionEnd = this.editor.document.offsetAt(selection.end);
				if (selectionEnd < selectionStart) {
					const tmp = selectionStart;
					selectionStart = selectionEnd;
					selectionEnd = tmp;
				}

				// Reveal the actual symbol if this selection intersects with it
				if (cursorStyle.startsWith("line")) {
					if (selectionEnd >= match.index && selectionStart <= match.index + match[0].length) {
						decorateSymbol = false;
						break;
					}
				} else {
					if (selectionEnd >= match.index - 1 && selectionStart <= match.index + match[0].length) {
						decorateSymbol = false;
						break;
					}
				}

				// No need to recheck whether or not decoration
				// should happen if it's already been determined
				// by another selection
				if (decorateSymbol) {
					continue;
				}

				// If the decoration specifies a scope, ensure the matched token is within that scope
				if (mask.scope || matchReplace?.scope) {
					const lineTokens = this.scopedDocument?.getTokens(this.editor.document.lineAt(startPos).lineNumber);
					if (lineTokens) {
						for (const token of lineTokens) {
							// Only check if the first character is within the scope
							// This allows more complex expressions to be matched, e.g.
							// `() =>` and `for (const ...`, by relying on the scope of
							// the first token
							if (startPos.character >= token.startIndex && startPos.character < token.endIndex) {
								// For the "match many" mask type
								if (matchReplace?.scope) {
									for (const scope of token.scopes) {
										if (scope.startsWith(matchReplace.scope)) {
											const remainder = scope.substring(matchReplace.scope.length);
											// If the token is within the scope, decorate it
											if (remainder.length === 0 || remainder.startsWith(".")) {
												decorateSymbol = true;
												break;
											}
										}
									}
								 } else if (mask.scope) {
									// Match a single scope
									for (const scope of token.scopes) {
										if (scope.startsWith(mask.scope)) {
											const remainder = scope.substring(mask.scope.length);
											// If the token is within the scope, decorate it
											if (remainder.length === 0 || remainder.startsWith(".")) {
												decorateSymbol = true;
												break;
											}
										}
									}
								}
							}
						}
					}
				} else {
					decorateSymbol = true;
				}
			}

			// If none of the selections intersect with the symbol
			// and it should be decorated according to the optionally
			// provided scope (if one was provided), then decorate it
			if (decorateSymbol) {
				let decorationKey = pattern.source;
				let hover = mask.hover;

				if (matchReplace?.text) {
					decorationKey += `@@@${matchReplace.text}`;
					if (!matchReplaceKeys.has(decorationKey)) {
						matchReplaceKeys.add(decorationKey);
						this.initialize(decorationKey, {
							text: matchReplace.text,
							scope: matchReplace.scope,
							backgroundColor: matchReplace.backgroundColor,
							border: matchReplace.border,
							borderColor: matchReplace.borderColor,
							color: matchReplace.color,
							fontStyle: matchReplace.fontStyle,
							fontWeight: matchReplace.fontWeight,
							css: matchReplace.css,
						});
					}

					hover = matchReplace.hover;
				}

				if (!decorationOptions.has(decorationKey)) {
					decorationOptions.set(decorationKey, []);
				}
				decorationOptions.get(decorationKey)?.push({
					range: new vscode.Range(startPos, endPos),
					hoverMessage: hover
				});
			}
		}

		for (const decorationKey of matchReplaceKeys.values()) {
			const decorationType = this.decorationTypeMap.get(decorationKey);
			if (decorationType) {
				this.editor.setDecorations(decorationType, decorationOptions.get(decorationKey) || []);
			}
		}

		const decorationType = this.decorationTypeMap.get(pattern.source);
		if (decorationType) {
			this.editor.setDecorations(decorationType, decorationOptions.get(pattern.source) || []);
		}

		// Clear all masks which were not matched but which are
		// still cached
		for (const key of this.decorationTypeMap.keys()) {
			if (key !== pattern.source && !(matchReplaceKeys.has(key))) {
				const decorationType = this.decorationTypeMap.get(key);
				if (decorationType) {
					this.editor.setDecorations(decorationType, []);
				}
				this.decorationTypeMap.delete(key);
			}
		}
	}
}