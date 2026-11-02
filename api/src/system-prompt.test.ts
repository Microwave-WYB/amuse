import assert from "node:assert/strict";
import { test } from "node:test";
import { unreachableIn } from "@amuse/pi";
import { systemRules } from "./system-prompt.ts";

test("every tool a rule of the system prompt names is declared from the start or comes with a skill the rule names", () => {
  for (const withSandbox of [true, false]) for (const rule of systemRules(withSandbox)) assert.deepEqual(unreachableIn(rule), [], rule.slice(0, 80));
});

test("the system prompt never names recall or pushes codemode", () => {
  const text = systemRules(true).join("\n");
  assert.doesNotMatch(text, /\brecall\b/);
  assert.doesNotMatch(text, /codemode/);
});
