// Explicit opt-in integration test: uses the operator's logged-in Codex account.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { defaults } from "../runner/config.ts";
import { terminate } from "../runner/process.ts";
const serverUrl = "http://127.0.0.1:8899",
  dataDir = path.resolve("../../.cache/e2e-runner");
async function api(action: string, args: unknown = {}) {
  const response = await fetch(serverUrl + "/api/room", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const data: any = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
await mkdir(dataDir, { recursive: true });
const bootstrap = await api("bootstrap");
const channel =
  bootstrap.channels.find((c: any) => c.name === "로컬 검증실") ||
  (await api("channel_create", {
    name: "로컬 검증실",
    password: "local-fixture-password",
  }));
await api("channel_update", { channelId: channel.id, heartbeatEnabled: false });
const pair = await api("pair_create"),
  auth = await api("pair_claim", { code: pair.code, name: "e2e-runner" });
await writeFile(
  path.join(dataDir, "auth.json"),
  JSON.stringify({ ...auth, serverUrl }),
  { mode: 0o600 },
);
const configFile = path.join(dataDir, "config.local.json");
await writeFile(
  configFile,
  JSON.stringify({
    ...defaults,
    serverUrl,
    dataDir,
    channels: [channel.id],
    profiles: [
      {
        ...defaults.profiles[0],
        binary: process.env.PANOPTICON_CODEX_BINARY || "codex",
        webSearch: false,
      },
    ],
    limits: { ...defaults.limits, maxTurnsPerRequest: 12 },
  }),
);
const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("../runner/main.ts", import.meta.url)),
    "start",
    "--config",
    configFile,
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
let logs = "";
child.stdout.on("data", (x) => {
  logs += x.toString();
});
child.stderr.on("data", () => {});
try {
  const start = Date.now();
  while (!logs.includes("실행 중")) {
    if (Date.now() - start > 20000) throw new Error("실행기 시작 실패");
    await delay(500);
  }
  const message = await api("message_post", {
    channelId: channel.id,
    text: "로컬 통합 검증입니다. 제공된 run_code 도구에서 javascript로 console.log(6*7)을 실행한 뒤 계산 결과를 짧게 답하세요. 실제 실행 결과를 근거로 남기세요.",
    clientMessageId: crypto.randomUUID(),
    verify: true,
  });
  let snapshot: any;
  while (Date.now() - start < 180000) {
    await delay(2000);
    snapshot = await api("snapshot", { channelId: channel.id });
    const round = snapshot.rounds.find((r: any) => r.triggerId === message.id);
    if (round && round.status !== "active") break;
  }
  const answers = snapshot.messages.filter(
    (m: any) => m.replyTo === message.id,
  );
  assert.ok(answers.some((m: any) => m.text.includes("42")));
  assert.ok(
    answers.some((m: any) =>
      JSON.parse(m.evidence).some(
        (e: any) => e.type === "code" && e.result?.stdout?.includes("42"),
      ),
    ),
  );
  assert.ok(answers.some((m: any) => m.phase === "summary"));
  console.log(
    JSON.stringify({
      result: "PASS",
      answers: answers.map((m: any) => ({ phase: m.phase, text: m.text })),
      channelId: channel.id,
    }),
  );
} finally {
  child.kill("SIGINT");
  await delay(300);
  terminate(child);
  await api("device_revoke", { deviceId: auth.deviceId });
}
