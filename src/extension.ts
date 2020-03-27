import * as vscode from "vscode";
import * as vsctm from "vscode-textmate";
import * as fs from "fs";
import * as path from "path";
import MaskController, { Mask } from "./mask-controller";
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

export function activate(context: vscode.ExtensionContext) {
	// A map from language id => mask
	const maskMap = new Map<string, any>();
	const maskController = new MaskController(vscode.window.activeTextEditor);
	const scopedDocument = new ScopedDocument(maskController.getEditor()?.document);
	let configuration = vscode.workspace.getConfiguration();
	let timeout: NodeJS.Timeout;
	let languageScopeName: string = "";

	/**
	 * Apply the user's masks to the currently active document
	 */
	const updateMasks = async () => {
		try {
			const document = scopedDocument.getDocument();
			const userMasks = (configuration.get("symbolMasks.masks") as any);

			if (document) {
				for (let mask of userMasks) {
					if (vscode.languages.match(mask.language, document) > 0) {
						maskMap.set(mask.language, mask.pattern);
						for (const pattern of mask.patterns) {
							const regex = new RegExp(pattern.pattern, pattern.ignoreCase ? "ig" : "g");
							maskController.apply(regex, {
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
				}
			}
		} catch (err) {
			console.error(err);
		}
	};

	/**
	 * Wait a little before updating the masks
	 * To avoid slowing the extension down
	 */
	const debounceUpdateMasks = () => {
		if (timeout) {
			clearTimeout(timeout);
		}
		timeout = setTimeout(updateMasks, 50);
	};

	/**
	 * Setup to load the textmate grammar for the document
	 */
	languageScopeName = getLanguageScopeName(maskController.getEditor()?.document?.languageId) || "";
	scopedDocument.setDocument(maskController.getEditor()?.document);
	maskController.setScopedDocument(scopedDocument);

	registry.loadGrammar(languageScopeName)
	.then(grammar => {
		scopedDocument.setGrammar(grammar);
		scopedDocument.tokenize();
		debounceUpdateMasks();
	})
	.catch(err => {
		console.log(err);
		scopedDocument.clearGrammar();
		debounceUpdateMasks();
	});

	/**
	 * Update masks when the text editor changes
	 */
	vscode.window.onDidChangeActiveTextEditor(async editor => {
		maskController.setEditor(editor);
		scopedDocument.setDocument(editor?.document);
		languageScopeName = getLanguageScopeName(maskController.getEditor()?.document.languageId) || "";
		// Tokenize the new document, if possible
		if (editor && languageScopeName) {
			scopedDocument.setGrammar(await registry.loadGrammar(languageScopeName));
			scopedDocument.tokenize();
		}
		debounceUpdateMasks();
	}, null, context.subscriptions);

	/**
	 * Update masks when the text editor is saved
	 * (because the file could have just obtained a grammar,
	 * or obtained a different one)
	 */
	vscode.workspace.onDidSaveTextDocument(async _ => {
		// Get the language scope name for the saved document and retokenize it
		languageScopeName = getLanguageScopeName(maskController.getEditor()?.document.languageId) || "";
		if (maskController.getEditor() && languageScopeName) {
			scopedDocument.setGrammar(await registry.loadGrammar(languageScopeName));
			scopedDocument.tokenize();
		}
	}, null, context.subscriptions);

	/**
	 * Update masks when the document changes
	 */
	vscode.window.onDidChangeTextEditorSelection(async event => {
		// If the document changed, retokenize it
		if (languageScopeName && scopedDocument.getDocument()?.isDirty) {
			scopedDocument.tokenize();
		}

		if (event.textEditor === maskController.getEditor()) {
			debounceUpdateMasks();
		}
	}, null, context.subscriptions);

	/**
	 * Update masks when settings are updated
	 */
	vscode.workspace.onDidChangeConfiguration(async event => {
		if (event.affectsConfiguration("symbolMasks")) {
			maskController.clear();
			configuration = vscode.workspace.getConfiguration();
			languageScopeName = getLanguageScopeName(maskController.getEditor()?.document.languageId) || "";
			if (languageScopeName) {
				scopedDocument.tokenize();
			}
			debounceUpdateMasks();
		}
	}, null, context.subscriptions);
}

export function deactivate() {}
