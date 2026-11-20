import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { conflicts, recommendedIds, selectedIds, selectChanges, toggleItem, type TuiItem } from "./tui.js";

function item(over: Partial<TuiItem> = {}): TuiItem {
  return {
    id: "a",
    name: "A",
    risk: "low",
    conflictsWith: [],
    recommended: false,
    selected: false,
    ...over,
  };
}

test("toggleItem selects and deselects", () => {
  const items = [item({ id: "a" })];
  toggleItem(items, 0);
  assert.equal(items[0]!.selected, true);
  toggleItem(items, 0);
  assert.equal(items[0]!.selected, false);
});

test("selecting a conflicting option deselects the rival", () => {
  const items = [
    item({ id: "zram", selected: true, conflictsWith: ["disk-swap"] }),
    item({ id: "disk-swap", conflictsWith: ["zram"] }),
  ];
  const note = toggleItem(items, 1);
  assert.equal(items[1]!.selected, true);
  assert.equal(items[0]!.selected, false);
  assert.match(note ?? "", /deselected zram/);
});

test("selecting an exclusive-group rival deselects the sibling", () => {
  const items = [
    item({ id: "kv-cache-quant-q8", selected: true, exclusiveGroup: "kv-cache-quant" }),
    item({ id: "kv-cache-quant-q4", exclusiveGroup: "kv-cache-quant" }),
  ];
  toggleItem(items, 1);
  assert.equal(items[1]!.selected, true);
  assert.equal(items[0]!.selected, false);
});

test("conflicts covers hard conflicts and exclusive groups", () => {
  assert.equal(conflicts(item({ conflictsWith: ["b"] }), item({ id: "b" })), true);
  assert.equal(conflicts(item({ exclusiveGroup: "g" }), item({ id: "b", exclusiveGroup: "g" })), true);
  assert.equal(conflicts(item({ exclusiveGroup: "g" }), item({ id: "b", exclusiveGroup: "h" })), false);
  assert.equal(conflicts(item({ id: "a" }), item({ id: "b" })), false);
});

test("selectedIds and recommendedIds report the sets", () => {
  const items = [
    item({ id: "a", selected: true, recommended: true }),
    item({ id: "b", selected: true }),
  ];
  assert.deepEqual(selectedIds(items), ["a", "b"]);
  assert.deepEqual(recommendedIds(items), ["a"]);
});

// --- interactive loop (with an injected fake TTY stream) ---------------------

interface FakeTty {
  stream: PassThrough;
  input: unknown;
  writes: string[];
  output: unknown;
}

function fakeTty(): FakeTty {
  const stream = new PassThrough();
  const anyStream = stream as unknown as Record<string, unknown>;
  anyStream["isTTY"] = true;
  anyStream["isRaw"] = false;
  anyStream["setRawMode"] = () => {};
  const writes: string[] = [];
  const output = {
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
  };
  return { stream, input: stream, writes, output };
}

async function runKeys(
  items: TuiItem[],
  keys: Array<{ name: string; ctrl?: boolean }>,
): Promise<{ selected: string[]; quit: boolean }> {
  const tty = fakeTty();
  const promise = selectChanges(items, {
    input: tty.input as never,
    output: tty.output as never,
  });
  await new Promise((r) => setImmediate(r));
  for (const key of keys) tty.stream.emit("keypress", "", key);
  return promise;
}

test("selectChanges toggles with the keyboard and applies on Enter", async () => {
  const items: TuiItem[] = [
    { id: "a", name: "A", risk: "low", conflictsWith: [], recommended: true, selected: true },
    { id: "b", name: "B", risk: "low", conflictsWith: [], recommended: false, selected: false },
  ];
  const result = await runKeys(items, [{ name: "down" }, { name: "space" }, { name: "return" }]);
  assert.deepEqual(result.selected, ["a", "b"]);
  assert.equal(result.quit, false);
});

test("selectChanges quits on Escape and Ctrl-C", async () => {
  const items: TuiItem[] = [item({ id: "a", selected: true })];
  const escaped = await runKeys(items, [{ name: "escape" }]);
  assert.deepEqual(escaped.selected, []);
  assert.equal(escaped.quit, true);

  const ctrlC = await runKeys(items, [{ name: "c", ctrl: true }]);
  assert.equal(ctrlC.quit, true);
});

test("selectChanges refuses to apply with nothing selected", async () => {
  const items: TuiItem[] = [item({ id: "a", selected: true })];
  // space deselects the only item, then Enter must not finish; escape does.
  const result = await runKeys(items, [{ name: "space" }, { name: "return" }, { name: "escape" }]);
  assert.equal(result.quit, true);
});
