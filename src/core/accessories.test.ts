import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateAnsible,
  generateChecklistMarkdown,
  generateDockerfile,
} from "./accessories.js";
import type { OptimizationOption } from "./types.js";

function envOption(value: string): OptimizationOption {
  return {
    id: "adversarial",
    name: "Adversarial fixture",
    description: "fixture",
    category: "runtime",
    platforms: ["linux"],
    requiresPrivilege: false,
    risk: "low",
    reversibility: "fully-reversible",
    resourceCost: {},
    expectedImprovement: { metric: "m", tier: "C" },
    conflictsWith: [],
    synergizesWith: [],
    requires: [],
    applyOp: "env",
    env: { ollama: { ADVERSARIAL: value } },
  };
}

test("Dockerfile output escapes a value that tries to break out of the quotes", () => {
  const out = generateDockerfile([envOption('"; rm -rf ~ #')]);
  // The quote must be escaped so it cannot terminate the ENV value early.
  assert.ok(out.includes('ENV ADVERSARIAL="\\"; rm -rf ~ #"'), out);
});

test("Ansible output escapes shell substitution in a value", () => {
  const out = generateAnsible([envOption("$(id)")]);
  assert.ok(out.includes('export ADVERSARIAL="\\$(id)"'), out);
});

test("checklist markdown lists every option", () => {
  const out = generateChecklistMarkdown([envOption("1")]);
  assert.ok(out.includes("Adversarial fixture"));
  assert.ok(out.includes("`adversarial`"));
});
