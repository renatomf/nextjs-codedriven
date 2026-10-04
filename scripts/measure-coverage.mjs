// Real test coverage of this repository (unit + integration, v8): the ground
// truth the analyzer's static Testing estimate is calibrated against
// (ADR-010 review, 2026-10-04). Integration tests need the local, disposable
// Postgres (DATABASE_URL), like `npm run test:integration`.
//
//   DATABASE_URL=postgresql://app:app@localhost:5433/app npm run measure:coverage
//
// Prints statement coverage and the share of files with functions whose
// functions some test ran (the same "exercised" idea as the heuristic), and
// writes the list of files no test runs to .coverage/not-exercised.txt.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".coverage");
const runs = [
  { name: "unit", args: [] },
  { name: "integration", args: ["--config", "vitest.integration.config.mts"] },
];

for (const run of runs) {
  // Vitest's own entry through Node: no shell on any platform.
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      ...run.args,
      "--coverage.enabled",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${path.join(out, run.name)}`,
      "--coverage.include=src/**",
    ],
    { cwd: root, stdio: "inherit" },
  );
}

const normalize = (file) => file.split("\\").join("/").replace(/^.*?\/src\//, "src/");
const files = new Map();
for (const run of runs) {
  const report = JSON.parse(fs.readFileSync(path.join(out, run.name, "coverage-final.json"), "utf8"));
  for (const [file, data] of Object.entries(report)) {
    const key = normalize(file);
    const merged = files.get(key) ?? {
      statements: {},
      functions: {},
      functionCount: Object.keys(data.fnMap).length,
      statementCount: Object.keys(data.statementMap).length,
    };
    for (const [id, hits] of Object.entries(data.s)) merged.statements[id] = (merged.statements[id] ?? 0) + hits;
    for (const [id, hits] of Object.entries(data.f)) merged.functions[id] = (merged.functions[id] ?? 0) + hits;
    files.set(key, merged);
  }
}

let statements = 0;
let covered = 0;
let withFunctions = 0;
const notExercised = [];
for (const [file, data] of files) {
  if (/\.(test|spec)\.|\/test\/|__snapshots__/.test(file)) continue;
  statements += data.statementCount;
  covered += Object.values(data.statements).filter((hits) => hits > 0).length;
  if (data.functionCount === 0) continue;
  withFunctions += 1;
  if (!Object.values(data.functions).some((hits) => hits > 0)) notExercised.push(file);
}

fs.writeFileSync(path.join(out, "not-exercised.txt"), notExercised.sort().join("\n"));
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString().slice(0, 10),
      statementsPercent: Math.round((covered / statements) * 100),
      filesWithFunctions: withFunctions,
      exercisedPercent: Math.round(((withFunctions - notExercised.length) / withFunctions) * 100),
      notExercised: notExercised.length,
    },
    null,
    1,
  ),
);
