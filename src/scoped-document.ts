import * as vscode from "vscode";
import * as vsctm from "vscode-textmate";

/**
 * A wrapper class for a vscode TextDocument which
 * determines scope information for each line
 */
export default class ScopedDocument {
	private document: vscode.TextDocument | undefined;

	private grammar: vsctm.IGrammar | null;

	private grammarState: Map<number, vsctm.StackElement | null>;

	constructor(document?: vscode.TextDocument, grammar?: vsctm.IGrammar) {
		this.document = document;
		this.grammar = grammar || null;
		this.grammarState = new Map();
		this.tokenize();
	}

	/**
	 * Update the grammar used for this document
	 */
	public setGrammar(grammar?: vsctm.IGrammar | null) {
		this.grammar = grammar || null;
	}

	public getDocument() {
		return this.document;
	}

	/**
	 * Update the grammar used for this document
	 */
	public setDocument(document?: vscode.TextDocument) {
		this.document = document;
	}

	/**
	 * Clear the loaded grammar for this document
	 */
	public clearGrammar() {
		this.grammarState.clear();
		this.grammar = null;
	}

	/**
	 * Get tokens for a given line number
	 * (note: make sure you tokenize the document before calling this method)
	 */
	public getTokens(lineNumber: number) {
		const prevState = this.grammarState.get(lineNumber - 1) || null;
		return this.grammar?.tokenizeLine(this.document?.lineAt(lineNumber).text || "", prevState).tokens;
	}

	/**
	 * Tokenize the document
	 */
	public tokenize = () => {
		this.grammarState.clear();

		if (this.document && this.grammar) {
			for (let i = 0; i < this.document.lineCount; i++) {
				const prevState = this.grammarState.get(i - 1) || null;
				const tokens = this.grammar.tokenizeLine(this.document.lineAt(i).text || "", prevState);
				this.grammarState.set(i, tokens.ruleStack);
			}
		}
	};
}