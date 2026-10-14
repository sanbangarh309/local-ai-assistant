import * as vscode from "vscode";
import * as path from "path";
import { ChatViewProvider } from "./ChatViewProvider";
import { AIClient } from "./AIClient";
import {
  parseEditPlan,
  type EditPlan,
  SEARCH_MARKER,
  DIVIDER_MARKER,
  REPLACE_MARKER,
} from "./planParser";
import { resolveFileUri, buildProjectScanContext } from "./workspaceContext";

const aiClient = new AIClient();

export type { EditPlan };

export interface ApplySummary {
  applied: string[];
  rejected: string[];
  failed: string[];
}

export function activate(context: vscode.ExtensionContext) {
  // Command version of the agent
  const disposable = vscode.commands.registerCommand(
    "local-ai-assistant.askAI",
    async () => {
      const question = await vscode.window.showInputBox({
        prompt: "What changes do you want to make?",
      });

      if (!question) {
        return;
      }

      if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage(
          "No project folder is open. Open a folder/workspace first.",
        );
        return;
      }

      const editor = vscode.window.activeTextEditor;

      // No open file - scan the project for relevant files instead of
      // requiring the user to open one first.
      const scan = editor
        ? undefined
        : await buildProjectScanContext(question);

      const fileName = editor?.document.fileName;
      const code = editor?.document.getText() ?? "";

      const prompt = editor
        ? `
  You are an expert AI software engineer.

  Analyze the user request and generate a structured edit plan.

  Current File Path:
  ${fileName}

  File Content:

  \`\`\`
  ${code}
  \`\`\`

  User Request:
  ${question}

  Respond using EXACTLY this plain-text format (not JSON, not markdown):

  SUMMARY: Brief description of changes
  FILE: ${fileName}
  ${SEARCH_MARKER}
  the exact existing lines of code to replace
  ${DIVIDER_MARKER}
  the new lines of code to insert instead
  ${REPLACE_MARKER}

  Rules:

  - Repeat the FILE/SEARCH/REPLACE block for each separate change.
  - "SEARCH" must match characters in the code precisely, including indentation.
  - Keep each SEARCH block as SHORT as possible: only the lines that actually
    change, plus 1-2 lines of surrounding context. Never reproduce an entire
    function/file if only a few lines change - split large edits into multiple
    small FILE/SEARCH/REPLACE blocks instead.
  - Do not invent code that does not exist in the SEARCH block.
  - Do not wrap the response in markdown code fences.
  - Do not add any commentary outside the SUMMARY/FILE/SEARCH/REPLACE blocks.
  `
        : `
  You are an expert AI software engineer.

  No file is currently open, so here is an automated scan of the current project:

  ${scan!.contextBlock}

  User Request:
  ${question}

  Respond using EXACTLY this plain-text format (not JSON, not markdown):

  SUMMARY: Brief description of changes
  FILE: exact relative path copied from the project file tree above
  ${SEARCH_MARKER}
  the exact existing lines of code to replace
  ${DIVIDER_MARKER}
  the new lines of code to insert instead
  ${REPLACE_MARKER}

  Rules:

  - Only target files that appear in the project file tree above.
  - Repeat the FILE/SEARCH/REPLACE block for each separate change, even across multiple files.
  - "SEARCH" must match characters in the code precisely, including indentation.
  - Do not invent code that does not exist in a file you haven't actually seen -
    if no snippet was pre-loaded for the file you need, respond with only a
    SUMMARY explaining what you'd need to see first, and no FILE blocks.
  - Do not wrap the response in markdown code fences.
  - Do not add any commentary outside the SUMMARY/FILE/SEARCH/REPLACE blocks.
  `;


      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "AI generating edit plan...",
          cancellable: false,
        },
        async () => {
          try {
            const answer = await aiClient.chat([
              {
                role: "system",
                content:
                  "You are a senior software engineer. Respond strictly using the requested FILE/SEARCH/REPLACE text format. Never use JSON or markdown.",
              },
              {
                role: "user",
                content: prompt,
              },
            ]);

            const plan = parseEditPlan(answer);

            await applyAgentPlan(plan);
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Agent failed: ${err?.message ?? String(err)}`,
            );
          }
        },
      );
    },
  );

  context.subscriptions.push(disposable);

  const provider = new ChatViewProvider(
    context.extensionUri,
    applyAgentPlan,
    aiClient,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("local-ai-chat", provider),
  );
}

// Global orchestration engine to execute the Agent Plan: group by file, preview a
// diff per file, and only touch the workspace once the user explicitly accepts it.
export async function applyAgentPlan(plan: EditPlan): Promise<ApplySummary> {
  const summary: ApplySummary = { applied: [], rejected: [], failed: [] };

  if (!plan.changes || plan.changes.length === 0) {
    vscode.window.showInformationMessage("No changes proposed by the AI.");
    return summary;
  }

  // Group changes by target file so each file is reviewed as a single diff,
  // matching how Copilot presents one review per file instead of per hunk.
  const changesByFile = new Map<string, EditPlan["changes"]>();
  for (const change of plan.changes) {
    const existing = changesByFile.get(change.file) ?? [];
    existing.push(change);
    changesByFile.set(change.file, existing);
  }

  for (const [file, changes] of changesByFile) {
    const baseName = path.basename(file);
    // The model's FILE path may be relative, differently-cased, or otherwise
    // mismatched from disk, so resolve it with multiple fallback strategies
    // instead of assuming it's a valid absolute path.
    const fileUri = await resolveFileUri(file);
    let document: vscode.TextDocument;

    if (!fileUri) {
      vscode.window.showErrorMessage(`Could not locate file in workspace: ${file}`);
      summary.failed.push(file);
      continue;
    }

    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      vscode.window.showErrorMessage(`Could not read file target: ${file}`);
      summary.failed.push(file);
      continue;
    }

    // Apply each search/replace sequentially against the running text so later
    // hunks see the effect of earlier ones, without touching the real document yet.
    let modifiedText = document.getText();
    const unmatchedHunks: string[] = [];
    for (const change of changes) {
      const range = findSearchRange(modifiedText, change.search);
      if (!range) {
        unmatchedHunks.push(firstLine(change.search));
        continue;
      }
      modifiedText =
        modifiedText.substring(0, range.start) +
        change.replace +
        modifiedText.substring(range.end);
    }

    if (unmatchedHunks.length > 0) {
      vscode.window.showWarningMessage(
        `Could not apply ${unmatchedHunks.length} patch(es) in ${baseName}. Search block(s) not found: ${unmatchedHunks.join(" | ")}`,
      );
    }

    if (modifiedText === document.getText()) {
      summary.failed.push(file);
      continue;
    }

    const tempDoc = await vscode.workspace.openTextDocument({
      content: modifiedText,
      language: document.languageId,
    });

    await vscode.commands.executeCommand(
      "vscode.diff",
      fileUri,
      tempDoc.uri,
      `AI Proposed Changes: ${baseName}`,
    );

    const choice = await vscode.window.showInformationMessage(
      `AI proposes changes to ${baseName}: ${plan.summary || "Refactoring"}. Apply modifications?`,
      { modal: false },
      "Accept & Apply",
      "Reject",
    );

    // Close the diff preview tab before moving on, whichever way the user decided.
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

    if (choice === "Accept & Apply") {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(fileUri, fullRange, modifiedText);
      const ok = await vscode.workspace.applyEdit(edit);

      if (ok) {
        summary.applied.push(file);
        vscode.window.showInformationMessage(`Successfully patched ${baseName}!`);
      } else {
        summary.failed.push(file);
        vscode.window.showErrorMessage(`Failed to apply patch to ${baseName}.`);
      }
    } else {
      summary.rejected.push(file);
    }
  }

  return summary;
}

export function deactivate() {}

function findSearchRange(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  const exactIndex = haystack.indexOf(needle);
  if (exactIndex !== -1) {
    return { start: exactIndex, end: exactIndex + needle.length };
  }

  // Models often drift on indentation/line endings while reproducing a large
  // block verbatim, so fall back to matching line content with flexible whitespace.
  const lines = needle.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const pattern = lines
    .map((line) => escapeRegExp(line.trim()))
    .join("[ \\t]*\\r?\\n[ \\t]*");

  try {
    const match = new RegExp(pattern).exec(haystack);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  } catch {
    // Malformed pattern - treat as no match.
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? text;
  return line.trim().slice(0, 60);
}
