import * as vscode from "vscode";
import { convertPrettifySymbols, ConversionResult, SymbolMask } from "./prettify-import";

export const IMPORT_COMMAND = "symbol-masks.importPrettifySymbols";

/**
 * A place prettify-symbols-mode substitutions were found in
 */
interface Source {
	label: string;
	target: vscode.ConfigurationTarget;
	/** The resource used to address workspace folder settings */
	resource?: vscode.Uri;
	value: unknown[];
}

/**
 * Register the "Symbol Masks: Import prettify-symbols-mode substitutions" command
 */
export function registerImportPrettifySymbols(): vscode.Disposable {
	return vscode.commands.registerCommand(IMPORT_COMMAND, () => importPrettifySymbols().catch(err => {
		console.error(err);
		vscode.window.showErrorMessage(`Symbol Masks: import failed: ${err}`);
	}));
}

/**
 * Find every settings scope that holds a non-empty prettifySymbolsMode.substitutions
 */
function findSources(): Source[] {
	const resource = vscode.window.activeTextEditor?.document.uri;
	const inspected = vscode.workspace.getConfiguration("prettifySymbolsMode", resource).inspect<unknown[]>("substitutions");
	const candidates: Array<Source | undefined> = [
		{ label: "User settings", target: vscode.ConfigurationTarget.Global, value: inspected?.globalValue as unknown[] },
		{ label: "Workspace settings", target: vscode.ConfigurationTarget.Workspace, value: inspected?.workspaceValue as unknown[] },
		{ label: "Workspace folder settings", target: vscode.ConfigurationTarget.WorkspaceFolder, resource, value: inspected?.workspaceFolderValue as unknown[] }
	];
	return candidates.filter((source): source is Source =>
		!!source && Array.isArray(source.value) && source.value.length > 0
		&& (source.target !== vscode.ConfigurationTarget.WorkspaceFolder || !!source.resource));
}

/**
 * Open the converted masks (and the notes) in an untitled JSON document
 */
async function preview(result: ConversionResult) {
	const lines: string[] = [];
	if (result.warnings.length) {
		lines.push("// Notes from the conversion:");
		for (const warning of result.warnings) {
			lines.push(`// - ${warning}`);
		}
		lines.push("");
	}
	lines.push(`// Paste into settings.json as the value of "symbolMasks.masks"`);
	lines.push(JSON.stringify(result.masks, null, 2));
	const document = await vscode.workspace.openTextDocument({ language: "jsonc", content: lines.join("\n") });
	await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Read prettifySymbolsMode.substitutions, convert it, and write it into
 * symbolMasks.masks after the user has picked what to do with it.
 * Nothing is written without an explicit choice.
 */
export async function importPrettifySymbols(): Promise<void> {
	const sources = findSources();
	if (sources.length === 0) {
		vscode.window.showInformationMessage(
			"Symbol Masks: no prettifySymbolsMode.substitutions found in your user or workspace settings, nothing to import.");
		return;
	}

	let source = sources[0];
	if (sources.length > 1) {
		const picked = await vscode.window.showQuickPick(sources.map(s => ({
			label: s.label,
			description: `${s.value.length} language ${s.value.length === 1 ? "entry" : "entries"}`,
			source: s
		})), { placeHolder: "Which prettify-symbols-mode substitutions should be imported?" });
		if (!picked) {
			return;
		}
		source = picked.source;
	}

	const result = convertPrettifySymbols(source.value);
	const summary = `${result.masks.length} mask${result.masks.length === 1 ? "" : "s"} / ${result.patternCount} pattern${result.patternCount === 1 ? "" : "s"} from ${result.substitutionCount} substitution${result.substitutionCount === 1 ? "" : "s"}`;
	const notes = result.warnings.length ? ` (${result.warnings.length} note${result.warnings.length === 1 ? "" : "s"})` : "";

	if (result.masks.length === 0) {
		const choice = await vscode.window.showWarningMessage(
			`Symbol Masks: nothing usable was found in ${source.label}${notes}.`, "Show notes");
		if (choice) {
			await preview(result);
		}
		return;
	}

	const symbolMasks = vscode.workspace.getConfiguration("symbolMasks", source.resource);
	const inspected = symbolMasks.inspect<SymbolMask[]>("masks");
	let existing: SymbolMask[] | undefined;
	switch (source.target) {
		case vscode.ConfigurationTarget.Global: existing = inspected?.globalValue; break;
		case vscode.ConfigurationTarget.Workspace: existing = inspected?.workspaceValue; break;
		case vscode.ConfigurationTarget.WorkspaceFolder: existing = inspected?.workspaceFolderValue; break;
	}
	const hasExisting = Array.isArray(existing) && existing.length > 0;

	type Action = "append" | "replace" | "preview" | "cancel";
	const items: Array<vscode.QuickPickItem & { action: Action }> = [];
	if (hasExisting) {
		items.push({
			action: "append",
			label: `Append to the ${existing!.length} mask${existing!.length === 1 ? "" : "s"} already in ${source.label}`,
			description: summary + notes
		});
		items.push({
			action: "replace",
			label: `Replace the ${existing!.length} mask${existing!.length === 1 ? "" : "s"} in ${source.label}`,
			description: summary + notes,
			detail: "The masks currently in symbolMasks.masks at this scope will be lost"
		});
	} else {
		items.push({
			action: "replace",
			label: `Write symbolMasks.masks in ${source.label}`,
			description: summary + notes
		});
	}
	items.push({
		action: "preview",
		label: "Show the converted masks in a new document instead",
		description: "Nothing is written to your settings"
	});
	items.push({ action: "cancel", label: "Cancel" });

	const choice = await vscode.window.showQuickPick(items, {
		placeHolder: `Import ${summary} from ${source.label} into symbolMasks.masks?`
	});
	if (!choice || choice.action === "cancel") {
		return;
	}
	if (choice.action === "preview") {
		await preview(result);
		return;
	}

	const value = choice.action === "append" ? [...(existing || []), ...result.masks] : result.masks;
	await symbolMasks.update("masks", value, source.target);

	const done = `Symbol Masks: imported ${summary} into ${source.label}${notes}.`;
	if (result.warnings.length) {
		const show = await vscode.window.showInformationMessage(done, "Show notes");
		if (show) {
			await preview(result);
		}
	} else {
		vscode.window.showInformationMessage(done);
	}
}
