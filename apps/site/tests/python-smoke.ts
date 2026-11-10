import assert from "node:assert/strict";
import { loadConfig } from "../runner/config.ts";
import { runCode } from "../runner/sandbox.ts";
const config = await loadConfig("../../config.local.json");
for (const [name, code, expected] of [
  ["arithmetic", "import math; print(math.factorial(6))", true],
  [
    "host-filesystem",
    'print(open("/host-private/credentials.json").read())',
    false,
  ],
  ["host-environment", 'import os; print(os.getenv("OPENAI_API_KEY"))', true],
  [
    "network",
    'import socket; socket.create_connection(("example.com",443),timeout=1)',
    false,
  ],
  ["write", 'open("/python/pwned","w").write("x")', false],
  ["timeout", "while True: pass", false],
] as const) {
  const result = await runCode(config, "python", code);
  console.log(name, result);
  assert.equal(result.ok, expected);
  if (name === "arithmetic") assert.match(result.stdout, /720/);
  if (name === "host-environment") assert.match(result.stdout, /None/);
}
