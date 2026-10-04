/**
 * A synthetic project that exercises every deterministic heuristic of the
 * analysis, including the known false positives (TD-31, `src/test/` not seen
 * as tests, secrets in test fixtures). Used by the characterization tests:
 * their snapshots pin today's behavior, and intended changes show up as a
 * snapshot diff.
 *
 * Fake credentials are assembled at runtime so no key-shaped literal sits in
 * the source (GitHub secret scanning flags the format, even for fakes).
 */

type File = { relativePath: string; content: string };

const lines = (count: number, line: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => line(i)).join("\n");

/** A function whose body spans `bodyLines` lines. */
const fn = (name: string, bodyLines: number) =>
  [`export function ${name}() {`, lines(bodyLines, (i) => `  const v${i} = ${i};`), "}"].join("\n");

const fakeAwsKey = ["AK", "IA", "EXAMPLEKEY000000"].join("");
const quoted = (value: string) => `"${value}"`;

export function analysisFixtureFiles(): File[] {
  const files: File[] = [];

  // Large files: 11 of them (only 10 become issues), one over 800 lines.
  files.push({ relativePath: "src/huge.ts", content: lines(850, (i) => `export const h${i} = ${i};`) });
  for (let n = 0; n < 10; n += 1) {
    files.push({
      relativePath: `src/large/large-${n}.ts`,
      content: lines(420 + n, (i) => `export const l${i} = ${i};`),
    });
  }

  // Complex functions: 13 (only 12 become issues), one over 150 lines.
  files.push({
    relativePath: "src/complex.ts",
    content: [fn("veryLong", 160), ...Array.from({ length: 12 }, (_, n) => fn(`long${n}`, 85))].join("\n\n"),
  });

  // TD-31: a parenthesized const expression followed by a long function.
  files.push({
    relativePath: "src/app/page.tsx",
    content: ["const scores = (defaults ??", "  null) as Scores | null;", "", fn("render", 90)].join("\n"),
  });

  // Tests: one source file with a matching test, one test folder not
  // recognized as tests (`src/test/`).
  files.push({ relativePath: "src/payment.ts", content: "export function charge() {}\n" });
  files.push({ relativePath: "src/payment.test.ts", content: "test('charge', () => {});\n" });
  files.push({
    relativePath: "src/test/helpers.ts",
    content: `export const password = ${quoted("fixture-password-123")};\n`,
  });
  files.push({
    relativePath: "src/__tests__/setup.ts",
    content: `export const apiKey = ${quoted("ignored-because-test-file")};\n`,
  });

  // A test fixture outside a test folder, holding a fake secret.
  files.push({
    relativePath: "src/lib/__fixtures__/credentials.ts",
    content: `export const apiKey = ${quoted("fixture-api-key-value")};\n`,
  });

  // Critical-looking paths without tests: 9 of them (only 8 become issues).
  // They have logic: files without it (constants, types) need no test.
  for (let n = 0; n < 9; n += 1) {
    files.push({
      relativePath: `src/auth/handler-${n}.ts`,
      content: "export function handle() {\n  return 1;\n}\n",
    });
  }

  // Secrets: 11 hits (only 10 become issues), one per pattern kind.
  files.push({
    relativePath: "src/config.ts",
    content: [
      `const awsKey = ${quoted(fakeAwsKey)};`,
      `const jwt_secret = ${quoted("short")};`,
      // `token:` (not `token0 =`): the pattern needs a word boundary.
      ...Array.from({ length: 9 }, (_, n) => `  token: ${quoted(`value-number-${n}`)},`),
    ].join("\n"),
  });

  return files;
}
