export interface EditPlan {
  summary: string;
  changes: {
    file: string; // Absolute or relative path
    search: string; // Code block to find
    replace: string; // Code block to substitute
  }[];
}

// Built via concatenation (not written as literal lines) so this source file
// doesn't contain real-looking git merge-conflict markers, which VS Code's
// conflict detector flags even inside a plain string/template literal.
export const SEARCH_MARKER = "<".repeat(7) + " SEARCH";
export const DIVIDER_MARKER = "=".repeat(7);
export const REPLACE_MARKER = ">".repeat(7) + " REPLACE";

const FILE_BLOCK_RE =
  /FILE:[ \t]*(.+?)[ \t]*\r?\n<{3,}[ \t]*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n={3,}[ \t]*\r?\n([\s\S]*?)\r?\n>{3,}[ \t]*REPLACE/g;

// Models reliably mis-escape raw source code embedded in JSON strings (quotes,
// backslashes, newlines), so plans are exchanged as plain SEARCH/REPLACE blocks
// instead - no escaping required, and far more robust than JSON.parse on LLM output.
export function parseEditPlan(raw: string): EditPlan {
  const text = raw
    .replace(/```[a-zA-Z]*\r?\n?/g, "")
    .replace(/```/g, "")
    .trim();

  const summaryMatch = text.match(/^SUMMARY:[ \t]*(.+)$/m);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";

  const changes: EditPlan["changes"] = [];
  const re = new RegExp(FILE_BLOCK_RE);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    changes.push({
      file: match[1].trim(),
      search: match[2],
      replace: match[3],
    });
  }

  if (changes.length === 0) {
    throw new Error(
      "The AI response didn't contain any valid FILE/SEARCH/REPLACE blocks.",
    );
  }

  return { summary, changes };
}
