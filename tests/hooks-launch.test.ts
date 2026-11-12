import { expect, test } from "bun:test";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("every command in .cursor/hooks.json can be launched, because Cursor runs it directly", () => {
  const config = JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf-8"));
  const commands = Object.values<Array<{ command: string }>>(config.hooks).flatMap((entries) => entries.map((e) => e.command));
  expect(commands.length).toBeGreaterThan(0);
  for (const command of new Set(commands)) {
    expect(() => accessSync(join(root, command), constants.X_OK), `${command} is not executable`).not.toThrow();
  }
});
