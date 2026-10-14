import axios from "axios";
import * as vscode from "vscode";

export type AIProvider = "ollama" | "lmstudio";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
  };
}

interface LMStudioChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
  }>;
}

// Parses a chat response body defensively: the server should return one JSON
// object, but a slow/cut-off connection can deliver a truncated or
// newline-delimited body - stitch those cases back together instead of
// surfacing a raw, uninformative JSON.parse error.
function parseChatResponseBody<T extends { message?: { content?: string } }>(
  raw: string,
): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Fall through to line-by-line recovery below.
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return undefined;
  }

  let combinedContent = "";
  let sawAny = false;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as T;
      if (parsed.message?.content !== undefined) {
        combinedContent += parsed.message.content;
        sawAny = true;
      }
    } catch {
      // Skip unparsable/partial line fragments.
    }
  }

  return sawAny ? ({ message: { content: combinedContent } } as T) : undefined;
}

export class AIClient {
  private getConfig() {
    const config = vscode.workspace.getConfiguration(
      "local-ai-assistant",
    );

    return {
      provider: config.get<AIProvider>(
        "provider",
        "ollama",
      ),

      ollamaUrl: config.get<string>(
        "ollamaUrl",
        "http://localhost:11434",
      ),

      ollamaModel: config.get<string>(
        "ollamaModel",
        "qwen3-coder:30b",
      ),

      // Keep the model resident between calls instead of reloading it each time,
      // and cap context size so a single request doesn't balloon memory usage.
      ollamaKeepAlive: config.get<string>(
        "ollamaKeepAlive",
        "5m",
      ),

      ollamaNumCtx: config.get<number>(
        "ollamaNumCtx",
        4096,
      ),

      lmStudioUrl: config.get<string>(
        "lmStudioUrl",
        "http://localhost:1234",
      ),

      lmStudioModel: config.get<string>(
        "lmStudioModel",
        "local-model",
      ),

      // Large local models (e.g. 30b) can take well over 2 minutes to respond,
      // especially on a cold load or a large prompt - default higher than axios' usual.
      requestTimeoutMs: config.get<number>(
        "requestTimeoutMs",
        300000,
      ),
    };
  }

  async chat(
    messages: ChatMessage[],
    temperature = 0.1,
    signal?: AbortSignal,
  ): Promise<string> {
    const config = this.getConfig();

    if (config.provider === "ollama") {
      return this.chatWithOllama(
        config.ollamaUrl,
        config.ollamaModel,
        messages,
        temperature,
        config.ollamaKeepAlive,
        config.ollamaNumCtx,
        config.requestTimeoutMs,
        signal,
      );
    }

    return this.chatWithLMStudio(
      config.lmStudioUrl,
      config.lmStudioModel,
      messages,
      temperature,
      config.requestTimeoutMs,
      signal,
    );
  }

  private async chatWithOllama(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    temperature: number,
    keepAlive: string,
    numCtx: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const response = await axios.post<string>(
        `${baseUrl.replace(/\/$/, "")}/api/chat`,
        {
          model,
          messages,
          stream: false,
          keep_alive: keepAlive,
          options: {
            temperature,
            num_ctx: numCtx,
          },
        },
        {
          timeout: timeoutMs,
          signal,
          responseType: "text",
        },
      );

      const parsed = parseChatResponseBody<OllamaChatResponse>(response.data);
      const content = parsed?.message?.content;

      if (!content) {
        throw new Error(
          `Ollama returned an empty or unparsable response for model "${model}". This can happen if the connection was cut off mid-response - try increasing "local-ai-assistant.requestTimeoutMs".`,
        );
      }

      return content;
    } catch (error: any) {
      if (axios.isCancel(error)) {
        throw new Error("Request cancelled.");
      }

      const message =
        error?.response?.data?.error ??
        error?.message ??
        String(error);

      throw new Error(
        `Ollama connection failed (${model}): ${message}`,
      );
    }
  }

  private async chatWithLMStudio(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    temperature: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const response = await axios.post<string>(
        `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          model,
          messages,
          temperature,
        },
        {
          timeout: timeoutMs,
          signal,
          responseType: "text",
        },
      );

      let parsed: LMStudioChatResponse | undefined;
      try {
        parsed = JSON.parse(response.data) as LMStudioChatResponse;
      } catch {
        parsed = undefined;
      }

      const content = parsed?.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error(
          `LM Studio returned an empty or unparsable response for model "${model}". This can happen if the connection was cut off mid-response - try increasing "local-ai-assistant.requestTimeoutMs".`,
        );
      }

      return content;
    } catch (error: any) {
      if (axios.isCancel(error)) {
        throw new Error("Request cancelled.");
      }

      const message =
        error?.response?.data?.error?.message ??
        error?.response?.data?.error ??
        error?.message ??
        String(error);

      throw new Error(
        `LM Studio connection failed (${model}): ${message}`,
      );
    }
  }

  async getOllamaModels(): Promise<string[]> {
    const config = this.getConfig();

    try {
      const response = await axios.get<OllamaTagsResponse>(
        `${config.ollamaUrl.replace(/\/$/, "")}/api/tags`,
        {
          timeout: 10000,
        },
      );

      return (
        response.data.models?.map(
          (model) => model.name,
        ) ?? []
      );
    } catch (error: any) {
      throw new Error(
        `Could not retrieve Ollama models: ${
          error?.message ?? String(error)
        }`,
      );
    }
  }
}