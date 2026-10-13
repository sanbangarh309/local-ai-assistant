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
        signal,
      );
    }

    return this.chatWithLMStudio(
      config.lmStudioUrl,
      config.lmStudioModel,
      messages,
      temperature,
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
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const response = await axios.post<OllamaChatResponse>(
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
          timeout: 120000,
          signal,
        },
      );

      const content = response.data.message?.content;

      if (!content) {
        throw new Error(
          `Ollama returned an empty response for model "${model}".`,
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
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const response = await axios.post<LMStudioChatResponse>(
        `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          model,
          messages,
          temperature,
        },
        {
          timeout: 120000,
          signal,
        },
      );

      const content =
        response.data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error(
          `LM Studio returned an empty response for model "${model}".`,
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