import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeDockerfileEnv,
  encodePowerShellDoubleQuoted,
  encodeShDoubleQuoted,
  findUnencodable,
} from "./encoding.js";

test("POSIX double-quote encoding neutralises command substitution", () => {
  assert.equal(encodeShDoubleQuoted("$(id)"), "\\$(id)");
  assert.equal(encodeShDoubleQuoted('"; rm -rf ~ #'), '\\"; rm -rf ~ #');
  assert.equal(encodeShDoubleQuoted("`id`"), "\\`id\\`");
  assert.equal(encodeShDoubleQuoted("a\\b"), "a\\\\b");
  assert.equal(encodeShDoubleQuoted("plain"), "plain");
});

test("PowerShell double-quote encoding escapes $, backtick and quote", () => {
  assert.equal(encodePowerShellDoubleQuoted("$env:PATH"), "`$env:PATH");
  assert.equal(encodePowerShellDoubleQuoted("`"), "``");
  assert.equal(encodePowerShellDoubleQuoted('a"b'), 'a`"b');
});

test("Dockerfile ENV encoding escapes $, quote and backslash", () => {
  assert.equal(encodeDockerfileEnv("$x"), "\\$x");
  assert.equal(encodeDockerfileEnv('a"b'), 'a\\"b');
  assert.equal(encodeDockerfileEnv("a\\b"), "a\\\\b");
});

test("findUnencodable flags newlines, NUL and template markers", () => {
  assert.ok(findUnencodable("a\nb"));
  assert.ok(findUnencodable("a\rb"));
  assert.ok(findUnencodable("a\0b"));
  assert.ok(findUnencodable("{{ lookup('pipe','id') }}"));
  assert.ok(findUnencodable("{% for x in y %}"));
  assert.equal(findUnencodable("plain value ${MANAGED_DIR}/hf"), undefined);
});
