import * as vscode from "vscode";
import axios from "axios";
import * as path from "path";
import { ChatViewProvider } from "./ChatViewProvider";

// Define the interface for our structured agent response
interface EditPlan {
  summary: string;
  changes: {
    file: string; // Absolute or relative path
    search: string; // Code block to find
    replace: string; // Code block to substitute
  }[];
}

async function askLMStudio(prompt: string): Promise<string> {
  try {
    const response = await axios.post(
      "http://localhost:1234/v1/chat/completions",
      {
        model: "local-model", // Or your specified model string
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1, // Lower temperature means more precise code replacements
      },
    );
    return response.data.choices[0].message.content;
  } catch (error) {
    throw new Error(`LM Studio Connection Failed: ${error}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Command version of the agent
  const disposable = vscode.commands.registerCommand(
    "local-ai-assistant.askAI",
    async () => {
      const question = await vscode.window.showInputBox({
        prompt: "What changes do you want to make to this file?",
      });

      if (!question) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Open a file first");
        return;
      }

      const document = editor.document;
      const fileName = document.fileName;
      const code = document.getText();

      const prompt = `
You are an expert AI software engineer.
Analyze the user request and generate a structured edit plan for the current file.

Current File Path: ${fileName}
File Content:
\`\`\`
${code}
\`\`\`

User Request: ${question}

Return ONLY valid JSON matching this exact schema:
{
  "summary": "Brief description of changes",
  "changes": [
    {
      "file": "${fileName.replace(/\\/g, "\\\\")}",
      "search": "The exact string of code lines to replace",
      "replace": "The new code lines to insert instead"
    }
  ]
}

Rules:
- "search" must match characters in the code precisely, including indentation.
- Return ONLY JSON. No markdown wrappers (\`\`\`json), no text before or after.
`;

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Agent generating edit plan...",
          cancellable: false,
        },
        async () => {
          try {
            const answer = await askLMStudio(prompt);
            // Clean up possible markdown fences if the model ignored instructions
            const jsonString = answer
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim();
            const plan: EditPlan = JSON.parse(jsonString);

            await applyAgentPlan(plan);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Agent failed: ${err.message}`);
          }
        },
      );
    },
  );

  context.subscriptions.push(disposable);

  const provider = new ChatViewProvider(context.extensionUri, applyAgentPlan);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("local-ai-chat", provider),
  );
}

// Global orchestration engine to execute the Agent Plan (Stages 3, 4, 5)
export async function applyAgentPlan(plan: EditPlan) {
  if (!plan.changes || plan.changes.length === 0) {
    vscode.window.showInformationMessage("No changes proposed by the AI.");
    return;
  }

  const edit = new vscode.WorkspaceEdit();

  // For this initial multi-stage baseline, we'll review and apply changes
  for (const change of plan.changes) {
    const fileUri = vscode.Uri.file(change.file);
    let document: vscode.TextDocument;

    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      vscode.window.showErrorMessage(
        `Could not read file target: ${change.file}`,
      );
      continue;
    }

    const text = document.getText();
    const startIndex = text.indexOf(change.search);

    if (startIndex === -1) {
      vscode.window.showWarningMessage(
        `Could not apply patch in ${path.basename(change.file)}. Search block not found precisely.`,
      );
      continue;
    }

    const startPos = document.positionAt(startIndex);
    const endPos = document.positionAt(startIndex + change.search.length);
    const range = new vscode.Range(startPos, endPos);

    // Stage 5: Diff Viewer Preview creation
    // Write out a temporary file representing what the change *would* look like
    const modifiedText =
      text.substring(0, startIndex) +
      change.replace +
      text.substring(startIndex + change.search.length);
    const tempDoc = await vscode.workspace.openTextDocument({
      content: modifiedText,
      language: document.languageId,
    });

    // Fire the native VS Code Diff view
    await vscode.commands.executeCommand(
      "vscode.diff",
      fileUri,
      tempDoc.uri,
      `AI Proposed Changes: ${path.basename(change.file)}`,
    );

    // Stage 4: User Confirmation
    const choice = await vscode.window.showInformationMessage(
      `AI proposes changes: ${plan.summary || "Refactoring"}. Apply modifications?`,
      "Accept & Apply",
      "Reject",
    );

    if (choice === "Accept & Apply") {
      // Stage 3: WorkspaceEdit deployment
      edit.replace(fileUri, range, change.replace);
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(
        `Successfully patched ${path.basename(change.file)}!`,
      );
    }
  }
}

export function deactivate() {}
