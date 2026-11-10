import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { loadAuth } from "./client.ts";
const index = process.argv.indexOf("--config"),
  config = await loadConfig(
    index >= 0 ? process.argv[index + 1] : "config.local.json",
  ),
  auth = await loadAuth(config);
for await (const line of createInterface({ input: process.stdin })) {
  let body: any;
  try {
    if (line.length > 180000) throw new Error("MCP 요청 크기 초과");
    body = JSON.parse(line);
    const response = await fetch(`${config.serverUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`MCP 서버 오류 ${response.status}`);
    if (response.status !== 204 && body.id !== undefined)
      process.stdout.write(JSON.stringify(await response.json()) + "\n");
  } catch (e) {
    if (body?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32603,
            message: e instanceof Error ? e.message : "MCP 오류",
          },
        }) + "\n",
      );
  }
}
