import { resolveApiKey, resolveApiConnection, type Profile } from "./config.ts";
import type { ModelResult } from "./adapters.ts";
import { DEFAULT_TURN_TIMEOUT_SECONDS } from "../lib/execution-limits.ts";
const packageImport = (name: string): Promise<any> => import(name);
export async function apiTurn(
  profile: Profile,
  instructions: string,
  input: string,
  signal: AbortSignal,
  loadSDK: (name: string) => Promise<any> = packageImport,
  timeoutMs = DEFAULT_TURN_TIMEOUT_SECONDS * 1000,
): Promise<ModelResult> {
  if (profile.provider === "gemini") throw new Error("Gemini는 비활성입니다.");
  const apiKey = resolveApiKey(profile);
  if (!apiKey || !profile.model)
    throw new Error("프로필의 apiKey(또는 API 키 환경변수)와 model을 설정해 주세요.");
  const connection = resolveApiConnection(profile);
  const options = { apiKey, baseURL: connection.baseURL, maxRetries: 0, timeout: timeoutMs };
  if (connection.apiFormat === "messages") {
    const { default: Anthropic } = await loadSDK(connection.sdk);
    const client = new Anthropic(options);
    const response = await client.messages.create(
      {
        model: profile.model,
        max_tokens: connection.maxOutputTokens,
        ...(profile.reasoningEffort !== undefined ? { output_config: { effort: profile.reasoningEffort } } : {}),
        system: instructions,
        messages: [{ role: "user", content: input }],
        ...(profile.webSearch
          ? {
              tools: [
                {
                  type: "web_search_20250305",
                  name: "web_search",
                  max_uses: 3,
                },
              ],
            }
          : {}),
      },
      { signal },
    );
    return {
      text: response.content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join("\n"),
      usage: response.usage,
      sources: response.content.filter(
        (x: any) => x.type === "web_search_tool_result",
      ),
    };
  }
  const { default: OpenAI } = await loadSDK(connection.sdk);
  const client = new OpenAI(options);
  if (connection.apiFormat === "chat-completions") {
    const response = await client.chat.completions.create({
      model: profile.model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input },
      ],
      stream: false,
      ...(profile.reasoningEffort !== undefined ? { reasoning_effort: profile.reasoningEffort } : {}),
      ...(profile.provider === "openai"
        ? { max_completion_tokens: connection.maxOutputTokens }
        : { max_tokens: connection.maxOutputTokens }),
    }, { signal });
    const choice = response.choices?.[0];
    if (choice?.finish_reason === "length")
      throw new Error("출력 한도에 도달했습니다. maxOutputTokens를 늘려 주세요.");
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim())
      throw new Error("API에서 최종 답변을 받지 못했습니다. 모델과 출력 한도를 확인해 주세요.");
    return { text: text.trim(), usage: response.usage || null, sources: choice.message.annotations || [] };
  }
  const response = await client.responses.create(
    {
      model: profile.model,
      instructions,
      input,
      store: false,
      max_output_tokens: connection.maxOutputTokens,
      ...(profile.reasoningEffort !== undefined ? { reasoning: { effort: profile.reasoningEffort } } : {}),
      ...(profile.webSearch ? { tools: [{ type: "web_search" }] } : {}),
    },
    { signal },
  );
  return {
    text: response.output_text || "",
    usage: response.usage || null,
    sources:
      response.output
        ?.filter(
          (x: any) =>
            x.type === "web_search_call" ||
            (x.type === "message" &&
              x.content?.some((c: any) => c.annotations?.length)),
        )
        .map((x: any) =>
          x.type === "message"
            ? x.content.flatMap((c: any) => c.annotations || [])
            : x,
        ) || [],
  };
}
