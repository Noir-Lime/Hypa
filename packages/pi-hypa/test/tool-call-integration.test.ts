import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.js";

function harness(outcome = "Rewritten", compression: "ok" | "fail" | "throw" = "ok") {
  const handlers = new Map<string, (...args: any[]) => any>();
  const files: string[] = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, getActiveTools() { return ["bash"]; }, setActiveTools() {},
    async exec(_binary: string, args: string[]) {
      if (args[0] === "rewrite") return { code: 0, stdout: JSON.stringify({ input: args[2], outcome, command: "hypa -c BROKEN", reason: "policy" }) };
      assert.equal(args[0], "compress");
      const file = args.at(-1)!;
      files.push(file);
      assert.equal(await readFile(file, "utf8"), "original\n".repeat(300));
      if (compression === "throw") throw new Error("offline");
      return { code: compression === "fail" ? 1 : 0, stdout: "summary\n", killed: false };
    },
  };
  const previous = process.env.HYPA_PI_ENABLE_MCP_PROXY;
  process.env.HYPA_PI_ENABLE_MCP_PROXY = "0";
  try { register(pi as unknown as ExtensionAPI); } finally {
    if (previous === undefined) delete process.env.HYPA_PI_ENABLE_MCP_PROXY;
    else process.env.HYPA_PI_ENABLE_MCP_PROXY = previous;
  }
  return { handlers, files };
}

const scripts = [
  'printf "FIRST\\n"\nprintf "SECOND\\n"',
  "cat <<'END'\nhello $USER\nEND",
  "value=world\nprintf '%s\\n' \"hello $value\"",
  "items=(one two)\nprintf '%s\\n' \"${items[@]}\"",
  "printf '%s\\n' joined\" words\" escaped\\ space",
  "printf '%s' before; exit 7",
];
for (const command of scripts) {
  test(`native Bash script survives hook: ${JSON.stringify(command)}`, async () => {
    const { handlers } = harness();
    const event = { type: "tool_call", toolName: "bash", toolCallId: "a", input: { command, timeout: 600 } };
    await handlers.get("tool_call")!(event, { hasUI: false });
    assert.deepEqual(event.input, { command, timeout: 600 });
    const run = (script: string) => {
      try { return { stdout: execFileSync("bash", ["-c", script], { encoding: "utf8" }), status: 0 }; }
      catch (error: any) { return { stdout: error.stdout, status: error.status }; }
    };
    assert.deepEqual(run(event.input.command), run(command));
  });
}

for (const mode of ["ok", "fail", "throw"] as const) {
  test(`output compression ${mode} keeps input intact and cleans temporary data`, async () => {
    const { handlers, files } = harness("Rewritten", mode);
    await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "a", input: { command: "printf test" } }, {});
    const event = { toolName: "bash", toolCallId: "a", content: [{ type: "text", text: "original\n".repeat(300) }], isError: false };
    const result = await handlers.get("tool_result")!(event);
    assert.deepEqual(result, mode === "ok" ? { content: [{ type: "text", text: "summary\n" }] } : undefined);
    assert.equal(files.length, 1);
    await assert.rejects(access(files[0]));
    assert.equal(await handlers.get("tool_result")!(event), undefined);
  });
}

test("policy deny and unconfirmed ask still block", async () => {
  for (const outcome of ["Deny", "Ask"]) {
    const { handlers } = harness(outcome);
    const result = await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "a", input: { command: "sudo reboot" } }, { hasUI: false });
    assert.equal(result.block, true);
  }
});

test("confirmed ask preserves the command", async () => {
  const { handlers } = harness("Ask");
  const event = { type: "tool_call", toolName: "bash", toolCallId: "a", input: { command: scripts[0] } };
  await handlers.get("tool_call")!(event, { hasUI: true, ui: { confirm: async () => true } });
  assert.equal(event.input.command, scripts[0]);
});

test("errors, truncated output, and passthrough are not compressed", async () => {
  for (const variant of ["error", "truncated", "passthrough"]) {
    const { handlers, files } = harness(variant === "passthrough" ? "Passthrough" : "Rewritten");
    await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "a", input: { command: "echo test" } }, {});
    const result = await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "a", content: [{ type: "text", text: "original\n".repeat(300) }], isError: variant === "error", details: variant === "truncated" ? { truncation: {} } : undefined });
    assert.equal(result, undefined);
    assert.equal(files.length, 0);
  }
});
