#!/usr/bin/env node
/**
 * Dependency-free lint pass.
 *
 * Run with `npm run lint`. GitHub Actions treats this as a required check, so it
 * deliberately covers the rules that would otherwise need a full ESLint setup to
 * enforce (we keep the backend zero-dependency to stay lightweight in CI).
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ file: string; line: number; message: string }[]} */
const problems = [];

function report(file, line, message) {
  problems.push({ file: relative(root, file), line, message });
}

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

const RULES = [
  {
    // Parameter properties are rejected by `node --experimental-strip-types`.
    name: "no-parameter-properties",
    pattern: /constructor\s*\([^)]*\b(private|public|protected|readonly)\s/,
    message: "TypeScript parameter properties break `node --experimental-strip-types`; declare fields explicitly",
    files: /^src\//,
  },
  {
    name: "no-console",
    pattern: /\bconsole\.(log|error|warn|info|debug)\s*\(/,
    message: "use the injected logger instead of console",
    files: /^src\//,
  },
  {
    name: "no-debugger",
    pattern: /\bdebugger\s*;/,
    message: "remove the debugger statement",
    files: /^src\//,
  },
  {
    name: "env-only-in-config",
    pattern: /\bprocess\.env\b/,
    message: "read configuration through loadConfig()/Config, not process.env",
    files: /^src\/(?!config\.ts$)/,
  },
  {
    name: "no-focused-tests",
    pattern: /\b(it|test|describe)\.only\s*\(/,
    message: "focused tests (.only) must not be committed",
    files: /^test\//,
  },
];

const files = [...(await collect(join(root, "src"))), ...(await collect(join(root, "test")))];
for (const file of files) {
  const relativePath = relative(root, file);
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
    if (isComment) return;
    for (const rule of RULES) {
      if (!rule.files.test(relativePath)) continue;
      if (rule.pattern.test(line)) report(file, index + 1, rule.message);
    }
  });

  if (text.length > 0 && !text.endsWith("\n")) {
    report(file, lines.length, "file must end with a newline");
  }

  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) report(file, index + 1, "trailing whitespace");
  });
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`${problem.file}:${problem.line}: ${problem.message}`);
  }
  console.error(`\nlint failed with ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log(`lint passed (${files.length} files)`);
}
