import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { runProcess } from "./process.ts";
export async function runCode(
  config: Config,
  language: string,
  code: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  if (
    !["python", "javascript"].includes(language) ||
    typeof code !== "string" ||
    Buffer.byteLength(code) > 32000
  )
    throw new Error("Python/JavaScript 코드 최대 32KiB만 지원합니다.");
  const settings = config.sandbox,
    request = {
      code,
      timeoutMs: settings.timeoutMs,
      memoryBytes: settings.memoryMiB * 1048576,
      outputBytes: settings.outputKiB * 1024,
    };
  if (settings.backend === "docker") {
    const name = `panopticon-${randomUUID()}`;
    try {
      const result = await runProcess(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--name",
          name,
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=32",
          `--memory=${settings.memoryMiB}m`,
          "--cpus=1",
          "--user=65534:65534",
          "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
          language === "python" ? "python:3.13.7-slim" : "node:24.8.0-slim",
          ...(language === "python"
            ? ["python", "-I", "-B", "-"]
            : ["node", "-"]),
        ],
        {
          input: code,
          signal,
          timeoutMs: settings.timeoutMs,
          maxOutput: request.outputBytes,
        },
      );
      return { ...result, ok: true };
    } finally {
      await runProcess("docker", ["rm", "-f", name], {
        timeoutMs: 15000,
      }).catch(() => {});
    }
  }
  if (language === "javascript") {
    const result = await runProcess(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./sandbox-worker.ts", import.meta.url)),
      ],
      {
        input: JSON.stringify(request),
        signal,
        timeoutMs: settings.timeoutMs + 5000,
        maxOutput: request.outputBytes * 3 + 10000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      },
    );
    return JSON.parse(result.stdout);
  }
  let runtime;
  try {
    runtime = JSON.parse(
      await readFile(
        path.join(config.dataDir, "runtimes", "python.json"),
        "utf8",
      ),
    );
  } catch {
    throw new Error(
      "Python 격리 실행을 준비하려면 npm run sandbox:setup을 실행하세요.",
    );
  }
  const result = await runProcess(runtime.binary, [], {
    input: JSON.stringify({ ...request, ...runtime }),
    signal,
    timeoutMs: settings.timeoutMs + 30000,
    maxOutput: request.outputBytes * 3 + 10000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  return JSON.parse(result.stdout);
}
