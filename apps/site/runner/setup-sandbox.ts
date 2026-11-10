import { mkdir, writeFile, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { loadConfig } from "./config.ts";
import { runProcess } from "./process.ts";
export async function setupSandbox(dataDir: string) {
  const root = path.join(dataDir, "runtimes"),
    python = path.join(root, "python");
  await mkdir(python, { recursive: true });
  const url =
    "https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.15.2/python-3.15.2-wasi_sdk-33.zip";
  console.log("고정 버전 CPython WASI 다운로드 및 SHA256 확인…");
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`다운로드 실패: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    "b8a63559c56760bbdc310dedb74fd69d10bcbafae26b705bea0ad353ad256888"
  )
    throw new Error("Python 배포 파일 체크섬 불일치");
  for (const [name, content] of Object.entries(unzipSync(bytes))) {
    const file = path.resolve(python, name);
    const relative = path.relative(python, file);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      name.includes("\\")
    )
      throw new Error("압축 파일 경로 오류");
    if (name.endsWith("/")) await mkdir(file, { recursive: true });
    else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }
  const find = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((x) =>
          x.isDirectory()
            ? find(path.join(dir, x.name))
            : [path.join(dir, x.name)],
        ),
      )
    ).flat();
  };
  const files = await find(python),
    wasmPath = files.find((x) => x.endsWith(".wasm")),
    osFile = files.find((x) => x.endsWith(`${path.sep}os.py`));
  if (!wasmPath || !osFile)
    throw new Error("Python 런타임 구성을 찾을 수 없습니다.");
  const runtimeDir = path.resolve(osFile, "../../..");
  const crate = fileURLToPath(new URL("../sandbox-host/", import.meta.url));
  console.log("로컬 Wasmtime 실행기 빌드… (Rust 필요)");
  await runProcess("cargo", ["build", "--release", "--locked"], {
    cwd: crate,
    timeoutMs: 900000,
    maxOutput: 20000,
  });
  const binary = `panopticon-sandbox${process.platform === "win32" ? ".exe" : ""}`;
  await copyFile(
    path.join(crate, "target", "release", binary),
    path.join(root, binary),
  );
  await writeFile(
    path.join(root, "python.json"),
    JSON.stringify(
      {
        wasmPath,
        runtimeDir,
        binary: path.join(root, binary),
        version: "3.15.2",
      },
      null,
      2,
    ),
  );
  console.log("Python·JavaScript 로컬 격리 실행 준비 완료.");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  setupSandbox((await loadConfig()).dataDir).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
