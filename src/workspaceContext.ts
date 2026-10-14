import * as vscode from "vscode";
import * as path from "path";

export interface ProjectScanContext {
  // Relative paths of the files whose content was pre-loaded into contextBlock.
  candidateFiles: string[];
  // Text block to splice into the AI prompt (file tree + relevant file snippets).
  contextBlock: string;
}

export const DEFAULT_EXCLUDE_GLOB =
  "**/{node_modules,.git,out,dist,build,.vscode-test,coverage,.next,vendor}/**";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".php", ".html", ".css", ".scss", ".less", ".vue", ".json", ".yml", ".yaml",
  ".md", ".sh",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "in", "of", "is", "it", "this",
  "that", "with", "on", "be", "as", "at", "by", "from", "can", "you", "please",
  "add", "make", "update", "change", "modify", "file", "code", "fix",
]);

function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  );
}

// Glob patterns treat (){}[]*?! as syntax, so a literal filename containing
// them (e.g. "Component (old).tsx") must be escaped before use in findFiles.
function escapeGlob(value: string): string {
  return value.replace(/[(){}\[\]*?!]/g, (ch) => `[${ch}]`);
}

export async function findFileMentionedInText(
  text: string,
): Promise<vscode.Uri | undefined> {
  const fileMatch = text.match(
    /(?:in|update|modify|change|file)\s+([a-zA-Z0-9_\-.\/\\:]+)/i,
  );
  if (!fileMatch || !fileMatch[1]) {
    return undefined;
  }

  const searchedName = fileMatch[1].trim();
  const found = await vscode.workspace.findFiles(
    `**/${escapeGlob(searchedName)}`,
    DEFAULT_EXCLUDE_GLOB,
    1,
  );
  return found[0];
}

// Resolves an AI-provided file path (absolute, relative to a workspace folder,
// or just mangled by the model) back to a real file on disk.
export async function resolveFileUri(
  file: string,
): Promise<vscode.Uri | undefined> {
  if (path.isAbsolute(file)) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(file));
      return vscode.Uri.file(file);
    } catch {
      // Doesn't exist at that exact absolute path - fall through to other strategies.
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = vscode.Uri.joinPath(folder.uri, file);
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // Try the next workspace folder.
    }
  }

  const base = path.basename(file);
  const found = await vscode.workspace.findFiles(
    `**/${escapeGlob(base)}`,
    DEFAULT_EXCLUDE_GLOB,
    1,
  );
  return found[0];
}

// Scans the whole open project for files relevant to the user's request, so the
// agent can propose edits without any file being open or explicitly named.
export async function buildProjectScanContext(
  messageText: string,
): Promise<ProjectScanContext> {
  const allFiles = await vscode.workspace.findFiles(
    "**/*",
    DEFAULT_EXCLUDE_GLOB,
    1000,
  );

  const relPath = (uri: vscode.Uri) =>
    vscode.workspace.asRelativePath(uri, false);

  const codeFiles = allFiles.filter((uri) =>
    CODE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase()),
  );

  const keywords = extractKeywords(messageText);

  const nameScored = codeFiles
    .map((uri) => {
      const rel = relPath(uri).toLowerCase();
      const score = keywords.reduce(
        (total, word) => total + (rel.includes(word) ? 3 : 0),
        0,
      );
      return { uri, score };
    })
    .sort((a, b) => b.score - a.score);

  let topCandidates = nameScored.filter((entry) => entry.score > 0);

  // No filename hits - peek into a bounded subset of file contents instead.
  if (topCandidates.length === 0 && keywords.length > 0) {
    const peekSet = codeFiles.slice(0, 80);
    const contentScored: { uri: vscode.Uri; score: number }[] = [];

    for (const uri of peekSet) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 200_000) {
          continue;
        }
        const text = Buffer.from(bytes).toString("utf8").toLowerCase();
        const score = keywords.reduce(
          (total, word) => total + (text.includes(word) ? 1 : 0),
          0,
        );
        if (score > 0) {
          contentScored.push({ uri, score });
        }
      } catch {
        // Unreadable/binary file - skip.
      }
    }

    topCandidates = contentScored.sort((a, b) => b.score - a.score);
  }

  // Keep this small - local models are usually run with a tiny context window
  // (e.g. 4096 tokens), so a bloated prompt slows responses or gets truncated.
  const snippetFiles = topCandidates.slice(0, 2);

  const treeEntries = allFiles.map((uri) => relPath(uri)).sort();
  const treeShown = treeEntries.slice(0, 150);
  const treeBlock =
    treeShown.join("\n") +
    (treeEntries.length > treeShown.length
      ? `\n...and ${treeEntries.length - treeShown.length} more files`
      : "");

  const snippetBlocks: string[] = [];
  const candidateFiles: string[] = [];
  for (const { uri } of snippetFiles) {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      const truncated =
        text.length > 3000 ? `${text.slice(0, 3000)}\n... (truncated)` : text;
      candidateFiles.push(relPath(uri));
      snippetBlocks.push(`--- ${relPath(uri)} ---\n\`\`\`\n${truncated}\n\`\`\``);
    } catch {
      // Skip files we can't open as text.
    }
  }

  const contextBlock = `Project File Tree (${treeEntries.length} files total):
${treeBlock}
${
  snippetBlocks.length > 0
    ? `\nMost likely relevant file(s):\n${snippetBlocks.join("\n\n")}`
    : "\n(No file content pre-loaded - pick the file that best matches the request from the tree above.)"
}`;

  return { candidateFiles, contextBlock };
}
