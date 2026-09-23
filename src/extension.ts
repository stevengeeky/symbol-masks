import * as vscode from "vscode";
import * as vsctm from "vscode-textmate";
import * as fs from "fs";
import * as path from "path";
import MaskController from "./mask-controller";
import ScopedDocument from "./scoped-document";

/**
 * A wrapper around fs.readFile which returns a Promise
 */
function readFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (error, data) => error ? reject(error) : resolve(data.toString()));
    });
}

/**
 * The textmate grammar registry.
 * Used to load textmate grammars
 */
const registry = new vsctm.Registry({
	/**
	 * Load the grammar for a given scope name
	 */
	loadGrammar: async (scopeName: string) => {
		for (const extension of vscode.extensions.all) {
			const grammars = extension.packageJSON.contributes?.grammars;
			if (grammars && grammars instanceof Array) {
				for (const grammar of grammars) {
					if (grammar.scopeName === scopeName) {
						const filePath = path.resolve(extension.extensionPath, grammar.path);
						const rawGrammar = await readFile(filePath);
						return vsctm.parseRawGrammar(rawGrammar, filePath);
					}
				}
			}
		}
		return null;
	}
});

/**
 * Get the textmate scope name for a given language id. (i.e. 'typescript')
 * This method is required when loading the textmate grammar for the language,
 * because the textmate scope must be used.
 */
const getLanguageScopeName = (languageId?: string) => {
	if (!languageId) {
		return null;
	}

	for (const extension of vscode.extensions.all) {
		const grammars = extension.packageJSON.contributes?.grammars;
		if (grammars && grammars instanceof Array) {
			for (const grammar of grammars) {
				if (grammar.language === languageId) {
					return grammar.scopeName;
				}
			}
		}
	}
	return null;
};

/**
 * Everything the extension keeps for one visible editor
 */
interface EditorState {
	editor: vscode.TextEditor;
	maskController: MaskController;
	scopedDocument: ScopedDocument;
	/**
	 * The textmate scope name of the document's language ("" if it has no grammar)
	 */
	languageScopeName: string;
	/**
	 * The pending debounced update, if any
	 */
	timeout?: NodeJS.Timeout;
}

/**
 * Build the RegExp flags for a pattern from the user's settings
 */
export function patternFlags(pattern: { ignoreCase?: boolean, multiline?: boolean }): string {
	return "g" + (pattern.ignoreCase ? "i" : "") + (pattern.multiline ? "m" : "");
}

export function activate(context: vscode.ExtensionContext) {
	// Every visible editor gets its own masks (#10)
	const states = new Map<vscode.TextEditor, EditorState>();
	let configuration = vscode.workspace.getConfiguration();

	/**
	 * Apply the user's masks to one visible editor
	 */
	const updateMasks = (state: EditorState) => {
		try {
			const document = state.editor.document;
			const userMasks = (configuration.get("symbolMasks.masks") as any[]) || [];

			state.maskController.beginUpdate();
			for (const mask of userMasks) {
				if (!mask || !mask.patterns || vscode.languages.match(mask.language, document) <= 0) {
					continue;
				}
				for (const pattern of mask.patterns) {
					if (!pattern || typeof pattern.pattern !== "string") {
						continue;
					}
					let regex: RegExp;
					try {
						regex = new RegExp(pattern.pattern, patternFlags(pattern));
					} catch (err) {
						console.error(`symbol-masks: invalid pattern ${JSON.stringify(pattern.pattern)}: ${err}`);
						continue;
					}
					state.maskController.apply(regex, {
						text: pattern.replace,
						scope: pattern.scope,
						hover: pattern.hover,
						backgroundColor: pattern.style?.backgroundColor,
						border: pattern.style?.border,
						borderColor: pattern.style?.borderColor,
						color: pattern.style?.color,
						fontStyle: pattern.style?.fontStyle,
						fontWeight: pattern.style?.fontWeight,
						css: pattern.style?.css
					});
				}
			}
			state.maskController.endUpdate();
		} catch (err) {
			console.error(err);
		}
	};

	/**
	 * Wait a little before updating the masks of an editor
	 * to avoid slowing the extension down
	 */
	const debounceUpdateMasks = (state: EditorState) => {
		if (state.timeout) {
			clearTimeout(state.timeout);
		}
		state.timeout = setTimeout(() => {
			state.timeout = undefined;
			// The editor may have gone away while we waited
			if (states.get(state.editor) === state) {
				updateMasks(state);
			}
		}, 50);
	};

	/**
	 * (Re)load the textmate grammar for an editor's document and tokenize it
	 */
	const loadGrammar = async (state: EditorState) => {
		state.languageScopeName = getLanguageScopeName(state.editor.document.languageId) || "";
		if (!state.languageScopeName) {
			state.scopedDocument.clearGrammar();
			return;
		}
		try {
			state.scopedDocument.setGrammar(await registry.loadGrammar(state.languageScopeName));
			state.scopedDocument.tokenize();
		} catch (err) {
			console.log(err);
			state.scopedDocument.clearGrammar();
		}
	};

	/**
	 * Start tracking a newly visible editor
	 */
	const track = async (editor: vscode.TextEditor) => {
		if (states.has(editor)) {
			return;
		}
		const scopedDocument = new ScopedDocument(editor.document);
		const maskController = new MaskController(editor, scopedDocument);
		const state: EditorState = { editor, maskController, scopedDocument, languageScopeName: "" };
		states.set(editor, state);
		await loadGrammar(state);
		debounceUpdateMasks(state);
	};

	/**
	 * Stop tracking an editor that is no longer visible
	 */
	const untrack = (editor: vscode.TextEditor) => {
		const state = states.get(editor);
		if (!state) {
			return;
		}
		if (state.timeout) {
			clearTimeout(state.timeout);
		}
		state.maskController.dispose();
		states.delete(editor);
	};

	/**
	 * Every tracked editor showing the given document
	 */
	const statesFor = (document: vscode.TextDocument) => {
		const result: EditorState[] = [];
		for (const state of states.values()) {
			if (state.editor.document === document) {
				result.push(state);
			}
		}
		return result;
	};

	/**
	 * Make the set of tracked editors equal to the set of visible editors
	 */
	const syncVisibleEditors = async (editors: ReadonlyArray<vscode.TextEditor>) => {
		const visible = new Set(editors);
		for (const editor of Array.from(states.keys())) {
			if (!visible.has(editor)) {
				untrack(editor);
			}
		}
		await Promise.all(editors.map(track));
	};

	syncVisibleEditors(vscode.window.visibleTextEditors);

	/**
	 * Track editors as they are opened and closed side by side (#10)
	 */
	vscode.window.onDidChangeVisibleTextEditors(editors => {
		syncVisibleEditors(editors);
	}, null, context.subscriptions);

	/**
	 * The document of a visible editor changed: retokenize it and mask it again
	 */
	vscode.workspace.onDidChangeTextDocument(event => {
		for (const state of statesFor(event.document)) {
			if (state.languageScopeName) {
				state.scopedDocument.tokenize();
			}
			debounceUpdateMasks(state);
		}
	}, null, context.subscriptions);

	/**
	 * Reload the grammar when a document is saved
	 * (because the file could have just obtained a grammar,
	 * or obtained a different one)
	 */
	vscode.workspace.onDidSaveTextDocument(async document => {
		for (const state of statesFor(document)) {
			await loadGrammar(state);
			debounceUpdateMasks(state);
		}
	}, null, context.subscriptions);

	/**
	 * Reveal the symbol under the cursor of the editor whose selection moved
	 */
	vscode.window.onDidChangeTextEditorSelection(event => {
		const state = states.get(event.textEditor);
		if (state) {
			debounceUpdateMasks(state);
		}
	}, null, context.subscriptions);

	/**
	 * Update masks when settings are updated
	 */
	vscode.workspace.onDidChangeConfiguration(async event => {
		if (event.affectsConfiguration("symbolMasks")) {
			configuration = vscode.workspace.getConfiguration();
			for (const state of states.values()) {
				state.maskController.clear();
				debounceUpdateMasks(state);
			}
		}
	}, null, context.subscriptions);

	context.subscriptions.push({
		dispose: () => {
			for (const editor of Array.from(states.keys())) {
				untrack(editor);
			}
		}
	});
}

export function deactivate() {}
