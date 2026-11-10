import { mkdir, writeFile, readFile, open, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { defaults, createExample, loadConfig } from "./config.ts";
import { LocalFiles } from "./files.ts";
import { Ledger } from "./ledger.ts";
import { probe } from "./adapters.ts";
import { call, loadAuth, RequestError } from "./client.ts";
import { executeTurn } from "./engine.ts";
import { runProcess } from "./process.ts";
import { setupSandbox } from "./setup-sandbox.ts";
import { isActiveProvider, providers } from "../lib/providers.ts";

const args = process.argv.slice(2),
  command = args[0] || "help";
const configIndex = args.indexOf("--config"),
  configFile = configIndex >= 0 ? args[configIndex + 1] : "config.local.json";
async function main() {
  if (command === "providers") {
    console.table(Object.entries(providers).map(([provider, info]) => ({
      provider,
      transport: info.cli ? "cli / api" : info.api ? "api" : "비활성",
      apiFormat: info.api?.format || "-",
      baseURL: info.api?.baseURL || (info.api ? "직접 지정" : "-"),
    })));
    return;
  }
  if (command === "init") {
    try {
      await createExample(configFile);
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const config = await loadConfig(configFile),
    files = new LocalFiles(config.dataDir);
  await mkdir(config.dataDir, { recursive: true });
  if (command === "init") {
    for (const profile of config.profiles) await files.initialize(profile.id);
    console.log(
      `설정: ${path.resolve(configFile)}\n성격·상황: ${files.root}\n연결: npm run runner -- pair`,
    );
    return;
  }
  if (command === "pair") {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let code: string;
    try {
      code = (
        await prompt.question("웹 화면에서 발급한 일회용 연결 코드: ")
      ).trim();
    } finally {
      prompt.close();
    }
    const auth = await call(config, null, "pair_claim", {
      code,
      name: os.hostname().slice(0, 60),
    });
    await writeFile(
      path.join(config.dataDir, "auth.json"),
      JSON.stringify({ ...auth, serverUrl: config.serverUrl }),
      { mode: 0o600 },
    );
    console.log(
      "연결 완료. 웹에서 가입한 채널 ID를 config.local.json의 channels에 넣으세요.",
    );
    return;
  }
  if (command === "doctor") {
    for (const profile of config.profiles)
      console.log(
        `${profile.id}: ${profile.enabled ? (await probe(profile)).detail : "비활성"}`,
      );
    try {
      await loadAuth(config);
      console.log("서버 연결 정보: 있음");
    } catch {
      console.log("서버 연결 정보: 없음");
    }
    try {
      await readFile(path.join(config.dataDir, "runtimes", "python.json"));
      console.log("Python WASI: 준비됨");
    } catch {
      console.log("Python WASI: npm run sandbox:setup 필요");
    }
    console.log(
      `historyMessageCount=${config.turn.historyMessageCount}, channels=${config.channels.length}`,
    );
    return;
  }
  if (command === "sandbox-setup") return setupSandbox(config.dataDir);
  if (command === "install-api") {
    const provider = args[1];
    if (!isActiveProvider(provider))
      throw new Error("install-api openai|anthropic|grok|exaone|openai-compatible");
    const npm = process.env.npm_execpath;
    if (!npm)
      throw new Error("npm run runner -- install-api <업체>로 실행해 주세요.");
    const wanted = providers[provider].api?.format === "messages" ? "@anthropic-ai/sdk" : "openai";
    const packages = [wanted];
    // npm --no-save would otherwise prune the other optional SDK.
    for (const name of ["openai", "@anthropic-ai/sdk"]) {
      if (name === wanted) continue;
      try {
        const installed = JSON.parse(await readFile(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8"));
        packages.push(`${name}@${installed.version}`);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await runProcess(
      process.execPath,
      [
        npm,
        "install",
        "--no-save",
        "--package-lock=false",
        ...packages,
      ],
      { cwd: fileURLToPath(new URL("./", import.meta.url)), timeoutMs: 180000 },
    );
    console.log("선택한 API SDK 설치 완료.");
    return;
  }
  if (command === "memory-history") {
    console.log((await files.history(args[1], args[2])).join("\n"));
    return;
  }
  if (command === "memory-restore") {
    await files.restore(args[1], args[2], args[3]);
    console.log("기억 복원 완료");
    return;
  }
  if (command !== "start") {
    console.log(
      "Panopticon runner\n  init | pair | doctor | start | providers | sandbox-setup\n  install-api openai|anthropic|grok|exaone|openai-compatible\n  memory-history <profile> <channel>\n  memory-restore <profile> <channel> <revisionFile>\n  --config <file>",
    );
    return;
  }
  const auth = await loadAuth(config);
  if (!config.channels.length)
    throw new Error(
      "config.local.json의 channels에 가입한 채널 ID를 추가하세요.",
    );
  const lockFile = path.join(config.dataDir, "runner.lock");
  try {
    const pid = Number(await readFile(lockFile, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error("같은 dataDir 실행기가 이미 실행 중입니다.");
    } catch (e: any) {
      if (e.code !== "ESRCH") throw e;
      await unlink(lockFile);
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const lock = await open(lockFile, "wx");
  await lock.writeFile(String(process.pid));
  const ledger = new Ledger(path.join(config.dataDir, "usage.sqlite")),
    running = new Map<
      string,
      { controller: AbortController; promise: Promise<void> }
    >();
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const item of running.values()) item.controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const ready = [];
    for (const profile of config.profiles.filter((p) => p.enabled)) {
      const state = await probe(profile);
      console.log(`${profile.name}: ${state.detail}`);
      if (state.ready) {
        ready.push(profile);
        await files.initialize(profile.id);
      }
    }
    if (!ready.length)
      throw new Error(
        "사용 가능한 참가자가 없습니다. doctor로 연결 설정을 확인하세요.",
      );
    for (const channelId of config.channels)
      await call(config, auth, "register", {
        channelId,
        profiles: ready.map((p) => ({
          id: p.id,
          name: p.name,
          provider: p.provider,
        })),
      });
    for (const item of ledger.pending())
      if (item.status === "running")
        ledger.finish(item.id, {
          jobId: item.id,
          error:
            "실행기 재시작으로 완료 여부가 불확실합니다. 자동 재호출하지 않았습니다.",
        });
    console.log(
      `실행 중 · ${ready.length}명 · ${config.channels.length}개 채널 · Ctrl+C로 종료`,
    );
    let lastError = "";
    while (!stopping) {
      try {
        for (const item of ledger
          .pending()
          .filter((x) => x.status === "finished")) {
          try {
            await call(config, auth, "job_complete", JSON.parse(item.payload!));
            ledger.acknowledged(item.id);
          } catch (e) {
            if (e instanceof RequestError && [403, 409].includes(e.status))
              ledger.acknowledged(item.id);
            else throw e;
          }
        }
        for (const [jobId, task] of running) {
          try {
            const state = await call(config, auth, "job_state", { jobId });
            if (state.status !== "running") task.controller.abort();
          } catch (e) {
            if (e instanceof RequestError && [401, 403].includes(e.status))
              task.controller.abort();
            else throw e;
          }
        }
        for (const channelId of config.channels) {
          const response = await call(config, auth, "poll", {
            channelId,
            historyMessageCount: config.turn.historyMessageCount,
            claim: running.size < config.limits.concurrency,
          });
          for (const turn of response.jobs) {
            const profile = ready.find(
                (p) => p.id === turn.participant.profileId,
              ),
              reserved = ledger.reserve(
                turn.job.id,
                turn.round.id,
                turn.round.requestorId,
                auth.ownerId,
                turn.round.kind === "heartbeat",
                config.limits,
              );
            if (!reserved.allowed || !profile) {
              const payload = {jobId: turn.job.id, skipped: true};
              if (reserved.allowed) ledger.finish(turn.job.id, payload);
              else ledger.skip(turn.job.id, payload);
              continue;
            }
            const controller = new AbortController();
            const promise = executeTurn(
              config,
              profile,
              turn,
              files,
              ledger,
              controller.signal,
            )
              .then((result) => {
                ledger.finish(turn.job.id, result);
              })
              .catch(() => {
                ledger.finish(turn.job.id, {
                  jobId: turn.job.id,
                  error: controller.signal.aborted
                    ? "작업이 취소되었습니다."
                    : `${profile.name} 호출 실패. 로컬 로그인·모델 설정·사용량을 확인하세요. 자동 재시도하지 않았습니다.`,
                });
              })
              .finally(() => running.delete(turn.job.id));
            running.set(turn.job.id, { controller, promise });
          }
        }
        lastError = "";
      } catch (e) {
        const message =
          e instanceof RequestError
            ? `서버 연결 오류 ${e.status}: ${e.message}`
            : "서버 연결이 끊겼습니다. 결과를 로컬에 보관하고 재접속합니다.";
        if (message !== lastError) console.error(message);
        lastError = message;
        if (e instanceof RequestError && [401, 403].includes(e.status)) stop();
      }
      if (!stopping) await delay(2000);
    }
    await Promise.allSettled([...running.values()].map((x) => x.promise));
    for (const channelId of config.channels)
      await call(config, auth, "register", { channelId, profiles: [] }).catch(
        () => {},
      );
  } finally {
    stop();
    await Promise.allSettled([...running.values()].map((x) => x.promise));
    ledger.close();
    await lock.close();
    await unlink(lockFile);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
