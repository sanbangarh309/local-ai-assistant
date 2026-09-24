import * as vscode from "vscode";
import axios from "axios";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  // Inject the global applier handler into the panel architect
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onApplyPlan: (plan: any) => Promise<void>,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type !== "chat") {
        return;
      }

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

Task: Generate an edit plan response strictly as valid JSON.
Schema structural requirements:
{
  "summary": "Short execution log summary",
  "changes": [
    {
      "file": "${targetFileName.replace(/\\/g, "\\\\")}",
      "search": "exact string match block of source code to swap out",
      "replace": "new lines of code replacing it"
    }
  ]
}
No conversation. No markdown formatting wrap. Only JSON.`;

        const response = await axios.post(
          "http://localhost:1234/v1/chat/completions",
          {
            model: "meta-llama-3.1-8b-instruct",
            temperature: 0.1,
            messages: [
              {
                role: "system",
                content:
                  "You are a senior code-generation engine that outputs strictly raw JSON. Never output markdown.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
          },
        );

        const contentRaw = response.data.choices[0].message.content;
        const cleanJsonStr = contentRaw
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();

        const aiPlan = JSON.parse(cleanJsonStr);

        webviewView.webview.postMessage({
          type: "response",
          text: `🤖 **Proposed Plan for ${vscode.workspace.asRelativePath(targetFileName)}:** ${aiPlan.summary || "Code updates generated."}`,
        });

        // Pass the plan to the global workspace editor logic
        await this.onApplyPlan(aiPlan);
      } catch (error: any) {
        console.error(error);
        webviewView.webview.postMessage({
          type: "error",
          text: `Error processing update payload: ${error?.message ?? String(error)}`,
        });
      }
    });
  }

  private getHtml() {
    // Keep your exact original HTML/CSS setup but modify message listener to handle clean updates
    return `<!DOCTYPE html>
<html>
<head>
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
.thinking{ color:#f1c40f; }
</style>
</head>
<body>
<div class="header">🤖 Local AI Agent Engine</div>
<div id="chat" class="chat"></div>
<div class="input-wrapper">
<textarea id="message" placeholder="Ask agent to write modifications..."></textarea>
<button onclick="send()">Send</button>
</div>
<script>
let thinkingElement = null;
const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');

function addMessage(text, cls){
    const div = document.createElement('div');
    div.className = 'message ' + cls;
    div.innerText = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function send(){
    const textarea = document.getElementById('message');
    const text = textarea.value;
    if(!text) return;
    addMessage(text,'user');
    textarea.value='';
    vscode.postMessage({ type:'chat', text:text });
}

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
    }
    if(message.type==='error'){
        if(thinkingElement) { thinkingElement.remove(); thinkingElement = null; }
        addMessage(message.text, 'ai');
    }
});
</script>
</body>
</html>`;
  }
}
