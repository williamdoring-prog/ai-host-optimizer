/**
 * Interactive checkbox selector (dependency-free).
 *
 * Shown after a system review: arrow keys move, space/left/right toggle, Enter
 * applies, Escape quits. Recommended, safe changes are pre-selected; the rest
 * start unchecked. Selecting an option deselects any conflicting or
 * exclusive-group rival, so the selection is always a valid plan.
 *
 * Uses `readline.emitKeypressEvents` + raw mode (no new dependency).
 */

import { emitKeypressEvents, type Key } from "node:readline";

export interface TuiItem {
  id: string;
  name: string;
  risk: string;
  conflictsWith: string[];
  exclusiveGroup?: string;
  /** True when this is a recommended, safe default (pre-selected). */
  recommended: boolean;
  selected: boolean;
}

export interface TuiResult {
  /** The selected option ids (empty when the user quit). */
  selected: string[];
  /** True when the user quit (Escape / q / Ctrl-C) without applying. */
  quit: boolean;
}

type RawInput = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

/** Do two items conflict (hard conflict either way, or the same exclusive group)? */
export function conflicts(a: TuiItem, b: TuiItem): boolean {
  return (
    a.conflictsWith.includes(b.id) ||
    b.conflictsWith.includes(a.id) ||
    (a.exclusiveGroup !== undefined && a.exclusiveGroup === b.exclusiveGroup)
  );
}

/**
 * Toggle item `index`. Enabling an option deselects any selected conflicting or
 * exclusive rival; returns a note when a rival was deselected. Pure.
 */
export function toggleItem(items: TuiItem[], index: number): string | undefined {
  const item = items[index];
  if (!item) return undefined;
  if (item.selected) {
    item.selected = false;
    return undefined;
  }
  item.selected = true;
  const dropped: string[] = [];
  for (const other of items) {
    if (other === item || !other.selected) continue;
    if (conflicts(item, other)) {
      other.selected = false;
      dropped.push(other.id);
    }
  }
  return dropped.length ? `deselected ${dropped.join(", ")} (conflicts)` : undefined;
}

/** The ids of the currently selected items. */
export function selectedIds(items: TuiItem[]): string[] {
  return items.filter((i) => i.selected).map((i) => i.id);
}

/** The ids of the recommended (pre-selected) items. */
export function recommendedIds(items: TuiItem[]): string[] {
  return items.filter((i) => i.recommended).map((i) => i.id);
}

export interface SelectOptions {
  title?: string;
  input?: RawInput;
  output?: NodeJS.WriteStream;
}

/** Run the interactive selector; resolves with the chosen ids or a quit signal. */
export async function selectChanges(
  items: TuiItem[],
  opts: SelectOptions = {},
): Promise<TuiResult> {
  const input = opts.input ?? (process.stdin as RawInput);
  const out = opts.output ?? process.stdout;
  if (!input.isTTY) throw new Error("the interactive selector needs a TTY");

  let cursor = 0;
  let note = "";
  let printed = 0;

  const frame = (): string[] => {
    const head = [
      opts.title ?? "Select changes to implement",
      "  ↑/↓ move · ←/→ or space toggle · a all · n none · enter apply · esc quit",
      "",
    ];
    const rows = items.map((it, i) => {
      const pointer = i === cursor ? "❯" : " ";
      const box = it.selected ? "[x]" : "[ ]";
      const star = it.recommended ? "  ★ recommended" : "";
      return `${pointer} ${box} ${it.name}  (${it.id})  risk:${it.risk}${star}`;
    });
    const selected = items.filter((i) => i.selected).length;
    const tail = ["", `  ${selected} of ${items.length} selected`];
    if (note) tail.push(`  ${note}`);
    return [...head, ...rows, ...tail];
  };

  const render = (): void => {
    const lines = frame();
    if (printed > 0) out.write(`\x1b[${printed}A`);
    out.write("\x1b[J");
    out.write(`${lines.join("\n")}\n`);
    printed = lines.length;
  };

  emitKeypressEvents(input);
  const wasRaw = input.isRaw ?? false;
  input.setRawMode?.(true);
  input.resume();
  out.write("\x1b[?25l"); // hide cursor
  render();

  return new Promise<TuiResult>((resolve) => {
    const cleanup = (): void => {
      input.removeListener("keypress", onKey);
      input.setRawMode?.(wasRaw);
      input.pause();
      out.write("\x1b[?25h"); // show cursor
    };
    const finish = (result: TuiResult): void => {
      cleanup();
      resolve(result);
    };

    function onKey(_str: string, key: Key): void {
      if (key.ctrl && key.name === "c") {
        finish({ selected: [], quit: true });
        return;
      }
      switch (key.name) {
        case "up":
          cursor = (cursor - 1 + items.length) % items.length;
          note = "";
          break;
        case "down":
          cursor = (cursor + 1) % items.length;
          note = "";
          break;
        case "left":
        case "right":
        case "space":
          note = toggleItem(items, cursor) ?? "";
          break;
        case "a":
          items.forEach((i) => {
            i.selected = true;
          });
          note = "selected all";
          break;
        case "n":
          items.forEach((i) => {
            i.selected = false;
          });
          note = "cleared";
          break;
        case "return":
        case "enter": {
          const selected = selectedIds(items);
          if (selected.length === 0) {
            note = "select at least one change (space)";
            break;
          }
          finish({ selected, quit: false });
          return;
        }
        case "escape":
        case "q":
          finish({ selected: [], quit: true });
          return;
        default:
          break;
      }
      render();
    }

    input.on("keypress", onKey);
  });
}
