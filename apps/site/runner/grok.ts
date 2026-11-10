import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { Profile } from "./config.ts";
import { runProcess } from "./process.ts";

export async function grokTurn(
  profile: Profile,
  instructions: string,
  input: string,
  cwd: string,
  signal: AbortSignal,
  run = runProcess,
) {
  // Windows limits command lines to 32,767 characters. History and evidence
  // routinely exceed that; keep the complete prompt out of the argument list.
  const directory = await mkdtemp(path.join(cwd, ".prompt-"));
  const promptFile = path.join(directory, "prompt.txt");
  try {
    await writeFile(promptFile, `${instructions}\n\n${input}`, { mode: 0o600 });
    const result = await run(
      profile.binary || "grok",
      [
        "--cwd", cwd,
        "--prompt-file", promptFile,
        "--output-format", "json",
        "--tools", profile.webSearch ? "web_search" : "",
        "--deny", "mcp__*",
        "--no-subagents",
        "--max-turns", "5",
        "--permission-mode", "dontAsk",
        "--sandbox", "strict",
        ...(profile.model ? ["--model", profile.model] : []),
      ],
      { cwd, signal },
    );
    const response = JSON.parse(result.stdout);
    if (response.is_error || response.error) throw new Error("Grok 호출 실패");
    return {
      text: response.result || response.text || response.content || "",
      usage: response.usage || null,
      sources: [],
    };
  } finally {
    await rm(promptFile, { force: true });
    await rmdir(directory);
  }
}
