import * as vscode from "vscode";
import { AIClient } from "./AIClient";
import type { ApplySummary } from "./extension";
import { parseEditPlan, type EditPlan } from "./planParser";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingRequest: AbortController | undefined;

  // Inject the global applier handler into the panel architect
 constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onApplyPlan: (plan: EditPlan) => Promise<ApplySummary>,
    private readonly aiClient: AIClient,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "cancel") {
        this.pendingRequest?.abort();
        return;
      }

      if (message.type !== "chat") {
        return;
      }

      // Avoid firing a second heavy model request while one is already loading/running -
      // on large local models this doubles memory pressure and can freeze the system.
      if (this.pendingRequest) {
        webviewView.webview.postMessage({
          type: "error",
          text: "⏳ A request is already in progress. Please wait for it to finish (or cancel it) before sending another.",
        });
        return;
      }

      const abortController = new AbortController();
      this.pendingRequest = abortController;

      try {
        webviewView.webview.postMessage({ type: "thinking" });

        let targetFileName = "Unknown";
        let code = "";
        let fileUri: vscode.Uri | undefined = undefined;

        // 1. Try to see if the user mentioned a specific file path/name in their text message
        // Matches patterns like "in UserController.php", "update api.php", "src/index.ts"
        const fileMatch = message.text.match(
          /(?:in|update|modify|change|file)\s+([a-zA-Z0-9_\-\.\/\\:]+)/i,
        );

        if (fileMatch && fileMatch[1]) {
          const searchedName = fileMatch[1].trim();
          // Search the entire workspace for this file name
          const foundFiles = await vscode.workspace.findFiles(
            `**/${searchedName}`,
            null,
            1,
          );

          if (foundFiles.length > 0) {
            fileUri = foundFiles[0];
            targetFileName = fileUri.fsPath;
            const document = await vscode.workspace.openTextDocument(fileUri);
            code = document.getText();
          }
        }

        // 2. Fallback: If no file was mentioned or found, use the currently active editor file
        if (!fileUri) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            fileUri = editor.document.uri;
            targetFileName = editor.document.fileName;
            const selectedCode = editor.document.getText(editor.selection);
            code =
              selectedCode.trim().length > 0
                ? selectedCode
                : editor.document.getText();
          }
        }

        // 3. Safety Check: If we still don't have code or a file, alert the user
        if (!fileUri || code.trim().length === 0) {
          webviewView.webview.postMessage({
            type: "error",
            text: "❌ Could not detect which file to modify. Please open a file or specify its name clearly (e.g., 'in UserController.php').",
          });
          return;
        }

        const prompt = `
Current File Context:
Path: ${targetFileName}
Code Block:
\`\`\`
${code}
\`\`\`

User Intent:
${message.text}

Task: Generate an edit plan response using EXACTLY this plain-text format (not JSON, not markdown):

SUMMARY: Short execution log summary
FILE: ${targetFileName}
<<<<<<< SEARCH
exact string match block of source code to swap out
=======
new lines of code replacing it
>>>>>>> REPLACE

Rules:
- Repeat the FILE/SEARCH/REPLACE block for each separate change.
- "SEARCH" must match characters in the code precisely, including indentation.
- Do not invent code that does not exist in the SEARCH block.
- Do not wrap the response in markdown code fences.
- Do not add any commentary outside the SUMMARY/FILE/SEARCH/REPLACE blocks.`;

        const contentRaw = await this.aiClient.chat(
          [
            {
              role: "system",
              content:
                "You are a senior code-generation engine that responds strictly using the requested FILE/SEARCH/REPLACE text format. Never output JSON or markdown.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          0.1,
          abortController.signal,
        );

        const aiPlan: EditPlan = parseEditPlan(contentRaw);

        if (!Array.isArray(aiPlan.changes) || aiPlan.changes.length === 0) {
          webviewView.webview.postMessage({
            type: "error",
            text: "❌ The AI did not propose any changes.",
          });
          return;
        }

        webviewView.webview.postMessage({
          type: "response",
          text: `🤖 **Proposed Plan for ${vscode.workspace.asRelativePath(targetFileName)}:** ${aiPlan.summary || "Code updates generated."}\n\nReview the diff and Accept/Reject in the dialog that appears.`,
        });

        // Pass the plan to the global workspace editor logic, which shows a diff
        // per file and only writes to disk once the user accepts it.
        const result = await this.onApplyPlan(aiPlan);

        const parts: string[] = [];
        if (result.applied.length > 0) {
          parts.push(`✅ Applied: ${result.applied.map((f) => vscode.workspace.asRelativePath(f)).join(", ")}`);
        }
        if (result.rejected.length > 0) {
          parts.push(`🚫 Rejected: ${result.rejected.map((f) => vscode.workspace.asRelativePath(f)).join(", ")}`);
        }
        if (result.failed.length > 0) {
          parts.push(`⚠️ Failed: ${result.failed.map((f) => vscode.workspace.asRelativePath(f)).join(", ")}`);
        }

        webviewView.webview.postMessage({
          type: "response",
          text: parts.length > 0 ? parts.join("\n") : "No changes were applied.",
        });
      } catch (error: any) {
        webviewView.webview.postMessage({
          type: "error",
          text: `Error processing update payload: ${error?.message ?? String(error)}`,
        });
      } finally {
        this.pendingRequest = undefined;
      }
    });
  }

  private getHtml(webview: vscode.Webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{ padding:0; margin:0; background:#1e1e1e; color:white; font-family:sans-serif; }
.header{ padding:12px; border-bottom:1px solid #333; font-weight:bold; }
.chat{ height:70vh; overflow:auto; padding:10px; }
.message{ padding:10px; border-radius:8px; margin-bottom:10px; white-space: pre-wrap;}
.user{ background:#0e639c; }
.ai{ background:#2d2d30; }
.input-wrapper{ display:flex; gap:8px; padding:10px; }
textarea{ flex:1; height:60px; background:#252526; color:white; border:1px solid #3c3c3c;}
button{ width:100px; background:#0e639c; color:white; border:none; cursor:pointer;}
button:hover{ background:#1177bb; }
button:disabled{ background:#3c3c3c; cursor:not-allowed; }
.thinking{ color:#f1c40f; }
</style>
</head>
<body>
<div class="header">🤖 Local AI Agent Engine</div>
<div id="chat" class="chat"></div>
<div class="input-wrapper">
<textarea id="message" placeholder="Ask agent to write modifications..."></textarea>
<button id="send">Send</button>
<button id="cancel" style="display:none;">Cancel</button>
</div>
<script nonce="${nonce}">
let thinkingElement = null;
const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');
const textarea = document.getElementById('message');
const sendButton = document.getElementById('send');
const cancelButton = document.getElementById('cancel');

function setBusy(isBusy){
    sendButton.disabled = isBusy;
    cancelButton.style.display = isBusy ? 'inline-block' : 'none';
}

function addMessage(text, cls){
    const div = document.createElement('div');
    div.className = 'message ' + cls;
    div.innerText = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function send(){
    if(sendButton.disabled) return;
    const text = textarea.value;
    if(!text) return;
    addMessage(text,'user');
    textarea.value='';
    setBusy(true);
    vscode.postMessage({ type:'chat', text:text });
}

function cancel(){
    vscode.postMessage({ type:'cancel' });
}

sendButton.addEventListener('click', send);
cancelButton.addEventListener('click', cancel);
textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
    }
});

window.addEventListener('message', event => {
    const message = event.data;
    if(message.type==='thinking'){
        if(thinkingElement) thinkingElement.remove();
        thinkingElement = document.createElement('div');
        thinkingElement.className = 'message thinking';
        thinkingElement.innerText = '🤔 Analyzing files & engineering patch...';
        chat.appendChild(thinkingElement);
    }
    if(message.type==='response'){
        if(thinkingElement) { thinkingElement.remove(); thinkingElement = null; }
        addMessage(message.text, 'ai');
        setBusy(false);
    }
    if(message.type==='error'){
        if(thinkingElement) { thinkingElement.remove(); thinkingElement = null; }
        addMessage(message.text, 'ai');
        setBusy(false);
    }
});
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
