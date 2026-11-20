import { test } from "node:test";
import assert from "node:assert/strict";

import { assertContained, isContained } from "./safety.js";

test("isContained accepts paths strictly inside the base", () => {
  assert.equal(isContained("/base", "/base/file.env"), true);
  assert.equal(isContained("/base", "/base/sub/dir/file.env"), true);
});

test("isContained rejects the base itself", () => {
  assert.equal(isContained("/base", "/base"), false);
});

test("isContained rejects sibling prefixes (no startsWith trap)", () => {
  // "/base-old" shares the "/base" prefix but is a different directory.
  assert.equal(isContained("/base", "/base-old/file"), false);
});

test("isContained rejects traversal and absolute escapes", () => {
  assert.equal(isContained("/base", "/base/../escape"), false);
  assert.equal(isContained("/base", "/etc/passwd"), false);
  assert.equal(isContained("/base", "/base/../../etc/passwd"), false);
});

test("assertContained throws with a clear message outside the base", () => {
  assert.throws(() => assertContained("/base", "/etc/passwd"), /outside the managed directory/);
  assert.doesNotThrow(() => assertContained("/base", "/base/ok.env"));
});
