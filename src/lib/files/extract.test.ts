import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

// Small limits so every guard can be hit with tiny fixtures.
vi.mock("@/lib/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/limits")>()),
  MAX_REPO_SIZE_BYTES: 4096,
  MAX_FILE_COUNT: 10,
  MAX_FILE_SIZE_BYTES: 1024,
  MAX_ZIP_ENTRIES: 20,
}));

import { extractFromZipBuffer } from "@/lib/files/extract";

type Entry = string | { content: string; unixPermissions?: number };

async function makeZip(entries: Record<string, Entry>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry === "string") {
      zip.file(name, entry, { createFolders: false });
    } else {
      zip.file(name, entry.content, {
        createFolders: false,
        unixPermissions: entry.unixPermissions,
      });
    }
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}

async function extractOk(
  entries: Record<string, Entry>,
  options?: { stripRoot?: boolean },
) {
  const result = await extractFromZipBuffer(await makeZip(entries), options);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

const paths = (files: Array<{ relativePath: string }>) =>
  files.map((file) => file.relativePath).sort();

describe("extractFromZipBuffer", () => {
  it("extracts source files and package.json", async () => {
    const result = await extractOk({
      "src/index.ts": "export const a = 1;",
      "package.json": "{}",
      "README.md": "# readme",
    });

    expect(paths(result.sourceFiles)).toEqual(["package.json", "src/index.ts"]);
    expect(result.allRelativePaths.sort()).toEqual([
      "README.md",
      "package.json",
      "src/index.ts",
    ]);
    expect(result.totalBytes).toBe(
      "export const a = 1;".length + "{}".length,
    );
  });

  it("strips the GitHub zipball root only when every entry shares it", async () => {
    const shared = await extractOk(
      { "repo-abc123/src/a.ts": "a", "repo-abc123/b.ts": "b" },
      { stripRoot: true },
    );
    expect(paths(shared.sourceFiles)).toEqual(["b.ts", "src/a.ts"]);

    const mixed = await extractOk(
      { "one/a.ts": "a", "two/b.ts": "b" },
      { stripRoot: true },
    );
    expect(paths(mixed.sourceFiles)).toEqual(["one/a.ts", "two/b.ts"]);
  });

  // JSZip (>= 3.8) already rewrites `../evil.ts` to `evil.ts` on load;
  // absolute and drive-letter names reach `isSafeRelativePath` and are
  // dropped. The assertion is on the invariant, whichever layer enforces it.
  it("never returns paths that escape the extraction root (zip-slip)", async () => {
    const result = await extractOk({
      "src/ok.ts": "ok",
      "../evil.ts": "evil",
      "src/../../evil2.ts": "evil",
      "/abs.ts": "evil",
      "C:/win.ts": "evil",
    });

    for (const relativePath of result.allRelativePaths) {
      expect(relativePath).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(relativePath).not.toMatch(/^\//);
      expect(relativePath).not.toMatch(/^[a-zA-Z]:/);
    }
    expect(paths(result.sourceFiles)).toContain("src/ok.ts");
  });

  it("skips symlinks", async () => {
    const result = await extractOk({
      "src/ok.ts": "ok",
      "src/link.ts": { content: "/etc/passwd", unixPermissions: 0o120777 },
    });

    expect(paths(result.sourceFiles)).toEqual(["src/ok.ts"]);
    expect(result.allRelativePaths).not.toContain("src/link.ts");
  });

  it("never reads secret-bearing files", async () => {
    const result = await extractOk({
      "src/ok.ts": "ok",
      ".env": "SECRET=1",
      ".env.local": "SECRET=1",
      "config/.npmrc": "//registry/:_authToken=x",
      "keys/id_rsa": "-----BEGIN-----",
      "certs/server.pem": "-----BEGIN-----",
    });

    expect(result.allRelativePaths).toEqual(["src/ok.ts"]);
  });

  it("skips files whose real decompressed size exceeds the per-file limit", async () => {
    // ~2 KB of repeated text compresses to a few bytes: a tiny zip bomb.
    const result = await extractOk({
      "src/ok.ts": "ok",
      "src/huge.ts": "a".repeat(2000),
    });

    expect(paths(result.sourceFiles)).toEqual(["src/ok.ts"]);
    expect(result.skippedLargeFiles).toEqual(["src/huge.ts"]);
  });

  it("skips binary content even with a source extension", async () => {
    const result = await extractOk({
      "src/ok.ts": "ok",
      "src/binary.ts": "abc\0def",
    });

    expect(paths(result.sourceFiles)).toEqual(["src/ok.ts"]);
  });

  it("respects the repository .gitignore", async () => {
    const result = await extractOk({
      ".gitignore": "generated/\n",
      "src/ok.ts": "ok",
      "generated/out.ts": "generated",
    });

    expect(paths(result.sourceFiles)).toEqual(["src/ok.ts"]);
  });

  it("rejects archives with too many entries", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`f${i}.md`, "x"]),
    );
    const result = await extractFromZipBuffer(await makeZip(entries));
    expect(result).toEqual({
      ok: false,
      error: "Archive contains too many entries.",
    });
  });

  it("rejects repositories above the file count limit", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`src/f${i}.ts`, "x"]),
    );
    const result = await extractFromZipBuffer(await makeZip(entries));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/file limit/);
  });

  it("counts only JS/TS files against the file count limit", async () => {
    // 12 translation files (not analyzed, not stored) + 2 source files.
    const entries = Object.fromEntries([
      ...Array.from({ length: 12 }, (_, i) => [`i18n/l${i}.json`, "{}"]),
      ["src/a.ts", "x"],
      ["src/b.ts", "y"],
    ]);
    const result = await extractFromZipBuffer(await makeZip(entries));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceFiles.map((f) => f.relativePath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
      // Still listed, for framework detection by file names.
      expect(result.allRelativePaths).toHaveLength(14);
    }
  });

  it("rejects repositories whose decompressed total exceeds the size limit", async () => {
    // Each file is under the per-file limit; together they exceed 4096 bytes.
    const entries = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`src/f${i}.ts`, "a".repeat(1000)]),
    );
    const result = await extractFromZipBuffer(await makeZip(entries));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/after filtering/);
  });

  it("rejects an archive larger than the size limit before unzipping", async () => {
    const result = await extractFromZipBuffer(Buffer.alloc(4097));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/size limit/);
  });

  it("returns a generic error for invalid archives", async () => {
    const result = await extractFromZipBuffer(Buffer.from("not a zip"));
    expect(result).toEqual({ ok: false, error: "Invalid or corrupted ZIP file." });
  });

  it("rejects archives without JS/TS sources", async () => {
    const result = await extractFromZipBuffer(
      await makeZip({ "README.md": "# hi", "package.json": "{}" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No JavaScript\/TypeScript/);
  });
});

// ADR-012: the root npm lockfile is read for the dependency scan, never stored.
describe("extractFromZipBuffer: dependencies", () => {
  const lockfile = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { express: "^4" } },
      "node_modules/express": { version: "4.17.1" },
      "node_modules/vitest": { version: "1.0.0", dev: true },
    },
  });

  it("lists the production dependencies of the root lockfile without storing it", async () => {
    const result = await extractOk({ "src/a.ts": "export {};", "package.json": "{}", "package-lock.json": lockfile });

    expect(result.dependencies).toEqual([{ name: "express", version: "4.17.1", direct: true }]);
    expect(paths(result.sourceFiles)).not.toContain("package-lock.json");
  });

  it("has no dependencies without a root lockfile (a nested one does not count)", async () => {
    const result = await extractOk({ "src/a.ts": "export {};", "packages/app/package-lock.json": lockfile });

    expect(result.dependencies).toBeNull();
  });

  it("reads the lockfile at the root of a stripped GitHub archive", async () => {
    const result = await extractOk(
      { "repo-abc/src/a.ts": "export {};", "repo-abc/package-lock.json": lockfile },
      { stripRoot: true },
    );

    expect(result.dependencies).toHaveLength(1);
  });
});
