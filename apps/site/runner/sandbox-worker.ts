import { getQuickJS } from "quickjs-emscripten";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 100000) throw new Error("입력 제한");
}
const request = JSON.parse(input),
  QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
runtime.setMemoryLimit(request.memoryBytes);
runtime.setMaxStackSize(512 * 1024);
const deadline = Date.now() + request.timeoutMs;
runtime.setInterruptHandler(() => Date.now() > deadline);
const vm = runtime.newContext();
let stdout = "";
const log = vm.newFunction("log", (...args) => {
  const line =
    args
      .map((x) => {
        const v = vm.dump(x);
        return typeof v === "string" ? v : JSON.stringify(v);
      })
      .join(" ") + "\n";
  if (Buffer.byteLength(stdout + line) > request.outputBytes)
    throw new Error("출력 제한 초과");
  stdout += line;
});
const consoleObject = vm.newObject();
vm.setProp(consoleObject, "log", log);
vm.setProp(consoleObject, "error", log);
vm.setProp(vm.global, "console", consoleObject);
log.dispose();
consoleObject.dispose();
let error: unknown = null;
try {
  const result = vm.evalCode(request.code);
  if (result.error) {
    error = vm.dump(result.error);
    result.error.dispose();
  } else result.value.dispose();
} catch (e) {
  error = String(e);
}
vm.dispose();
runtime.dispose();
process.stdout.write(
  JSON.stringify({
    stdout,
    stderr: error ? JSON.stringify(error) : "",
    ok: !error,
  }),
);
