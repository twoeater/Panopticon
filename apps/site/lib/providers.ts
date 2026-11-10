export type Provider =
  | "openai"
  | "anthropic"
  | "grok"
  | "exaone"
  | "openai-compatible"
  | "gemini";
export type ApiFormat = "responses" | "chat-completions" | "messages";
type ProviderDefinition = {
  label: string;
  cli?: string;
  api?: { baseURL?: string; format: ApiFormat; keyEnv: string };
};
export const providers: Record<Provider, ProviderDefinition> = {
  openai: {
    label: "OpenAI", cli: "codex",
    api: { baseURL: "https://api.openai.com/v1", format: "responses", keyEnv: "OPENAI_API_KEY" },
  },
  anthropic: {
    label: "Anthropic", cli: "claude",
    api: { baseURL: "https://api.anthropic.com", format: "messages", keyEnv: "ANTHROPIC_API_KEY" },
  },
  grok: {
    label: "Grok", cli: "grok",
    api: { baseURL: "https://api.x.ai/v1", format: "responses", keyEnv: "XAI_API_KEY" },
  },
  exaone: {
    label: "EXAONE",
    api: { baseURL: "https://api.exaone.ai/v1", format: "chat-completions", keyEnv: "EXAONE_API_KEY" },
  },
  "openai-compatible": {
    label: "OpenAI 호환",
    api: { format: "chat-completions", keyEnv: "OPENAI_COMPATIBLE_API_KEY" },
  },
  gemini: { label: "Gemini (준비 중)" },
};
export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && Object.hasOwn(providers, value);
}
export function isActiveProvider(value: unknown): value is Exclude<Provider, "gemini"> {
  return isProvider(value) && value !== "gemini";
}
