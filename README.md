# Local AI Assistant

A VS Code extension that connects to a locally running AI model (via
[Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai)) to answer
questions and propose code edits — without sending your code to the cloud.

## Features

- **Chat panel** — a dedicated "Local AI" view in the Activity Bar for
  conversational requests ("refactor this function", "add error handling to
  UserController.php", etc.).
- **Ask AI command** — run `Local AI Assistant: Ask AI` from the Command
  Palette to request changes to the currently open file.
- **Review before apply** — proposed edits are shown as a native VS Code diff
  (original vs. proposed) per file, and are only written to disk after you
  explicitly accept them.
- **Pluggable provider** — works with either a local Ollama server or LM
  Studio's OpenAI-compatible API.

## Requirements

You need a local model server running:

- **Ollama**: install from [ollama.com](https://ollama.com) and pull a model,
  e.g. `ollama pull qwen3-coder:30b`.
- **LM Studio**: install from [lmstudio.ai](https://lmstudio.ai), load a model,
  and start its local server.

## Extension Settings

This extension contributes the following settings:

* `local-ai-assistant.provider`: AI provider to use — `ollama` or `lmstudio`.
* `local-ai-assistant.ollamaUrl`: Ollama server URL (default `http://localhost:11434`).
* `local-ai-assistant.ollamaModel`: Ollama model name (default `qwen3-coder:30b`).
* `local-ai-assistant.ollamaKeepAlive`: how long Ollama keeps the model loaded in memory between requests (default `5m`).
* `local-ai-assistant.ollamaNumCtx`: context window size in tokens requested from Ollama (default `4096`).
* `local-ai-assistant.lmStudioUrl`: LM Studio server URL (default `http://localhost:1234`).
* `local-ai-assistant.lmStudioModel`: LM Studio model identifier (default `local-model`).

## Known Issues

- Edits rely on the model returning an exact `search` string match from the
  source file; if the model's output doesn't match the file precisely, that
  hunk is skipped and reported.
- **Large models on memory-constrained machines**: a model like `qwen3-coder:30b`
  can require ~18–20GB of RAM just to load. On a machine with 24GB total memory,
  this leaves very little headroom for macOS/VS Code, causing brief system-wide
  freezes (swapping) while the model loads or responds — this is OS-level memory
  pressure, not something the extension can fix directly. To reduce it:
  - Switch to a smaller/quantized model, e.g. `qwen2.5-coder:14b` or `:7b`
    (`ollama pull qwen2.5-coder:7b`), which uses a fraction of the memory.
  - Lower `local-ai-assistant.ollamaNumCtx` (e.g. to `2048`) to shrink the
    context buffer.
  - Lower `local-ai-assistant.ollamaKeepAlive` (e.g. to `1m` or `0`) if you'd
    rather free memory between requests at the cost of a reload delay on the
    next request.
  - Avoid sending a new chat message while one is still "thinking" — the
    extension now blocks overlapping requests and shows a Cancel button for
    this reason.

## Release Notes

### 0.0.1

Initial release: chat panel, Ask AI command, and diff-preview-before-apply
workflow for Ollama and LM Studio.
