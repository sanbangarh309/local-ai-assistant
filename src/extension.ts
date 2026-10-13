import * as vscode from "vscode";
import * as path from "path";
import { ChatViewProvider } from "./ChatViewProvider";
import { AIClient } from "./AIClient";
import { parseEditPlan, type EditPlan } from "./planParser";

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

      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        vscode.window.showErrorMessage(
          "Open a file first",
        );
        return;
      }

      const document = editor.document;
      const fileName = document.fileName;
      const code = document.getText();

      const prompt = `
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
  <<<<<<< SEARCH
  the exact existing lines of code to replace
  =======
  the new lines of code to insert instead
  >>>>>>> REPLACE

  Rules:

  - Repeat the FILE/SEARCH/REPLACE block for each separate change.
  - "SEARCH" must match characters in the code precisely, including indentation.
  - Do not invent code that does not exist in the SEARCH block.
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
    const fileUri = vscode.Uri.file(file);
    const baseName = path.basename(file);
    let document: vscode.TextDocument;

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
    let unmatched = 0;
    for (const change of changes) {
      const startIndex = modifiedText.indexOf(change.search);
      if (startIndex === -1) {
        unmatched++;
        continue;
      }
      modifiedText =
        modifiedText.substring(0, startIndex) +
        change.replace +
        modifiedText.substring(startIndex + change.search.length);
    }

    if (unmatched > 0) {
      vscode.window.showWarningMessage(
        `Could not apply ${unmatched} patch(es) in ${baseName}. Search block(s) not found precisely.`,
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
