/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("the health-app shell loads no remote font or stylesheet before consent", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

  expect(css).not.toMatch(/@import\s+(?:url\()?['"]?https?:\/\//i);
  expect(css).not.toMatch(/url\(\s*['"]?https?:\/\//i);
});
