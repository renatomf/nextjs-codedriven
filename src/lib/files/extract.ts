import {
  createGitignoreFilter,
  isSafeRelativePath,
  isSourceFile,
  normalizePath,
  shouldSkipPath,
  type ExtractedFile,
} from "@/lib/files/filters";
import {
  MAX_FILE_COUNT,
  MAX_FILE_SIZE_BYTES,
  MAX_LOCKFILE_BYTES,
  MAX_REPO_SIZE_BYTES,
  MAX_ZIP_ENTRIES,
} from "@/lib/limits";
import { parseNpmLockfile, type Dependency } from "@/modules/analysis";
import JSZip from "jszip";

const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

export type ExtractionResult =
  | {
      ok: true;
      sourceFiles: ExtractedFile[];
      allRelativePaths: string[];
      /** Decompressed bytes actually read. */
      totalBytes: number;
      skippedLargeFiles: string[];
      /** Production dependencies from the root npm lockfile; null without one (ADR-012). */
      dependencies: Dependency[] | null;
    }
  | {
      ok: false;
      error: string;
    };

const MAX_REPO_SIZE_MB = MAX_REPO_SIZE_BYTES / (1024 * 1024);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const mode = entry.unixPermissions;
  return typeof mode === "number" && (mode & S_IFMT) === S_IFLNK;
}

/**
 * GitHub zipballs wrap contents in a single root folder. Only strip it when
 * every entry actually shares that folder.
 */
function commonRoot(names: string[]): string | null {
  const first = names[0]?.split("/");
  if (!first || first.length < 2) return null;
  const root = `${first[0]}/`;
  return names.every((name) => name.startsWith(root)) ? root : null;
}

// JSZip's chunked stream API (untyped in index.d.ts).
type ZipStream = {
  on(event: "data", fn: (chunk: Uint8Array) => void): ZipStream;
  on(event: "end", fn: () => void): ZipStream;
  on(event: "error", fn: (error: unknown) => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
};

/**
 * Decompresses an entry counting the real output bytes. The size declared in
 * the ZIP header is attacker-controlled (zip bombs), so it is never trusted:
 * decompression stops as soon as `maxBytes` is exceeded. Returns null then.
 */
function readEntryLimited(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const stream = (
      entry as JSZip.JSZipObject & {
        internalStream(type: "uint8array"): ZipStream;
      }
    ).internalStream("uint8array");
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;

    stream
      .on("data", (chunk) => {
        if (done) return;
        size += chunk.byteLength;
        if (size > maxBytes) {
          done = true;
          stream.pause();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (error) => {
        if (done) return;
        done = true;
        reject(error);
      })
      .on("end", () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks));
      })
      .resume();
  });
}

/**
 * Text content for `code_chunks.content`. Files with NUL bytes are binary
 * (and Postgres `text` rejects \0), so they are skipped.
 */
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  return new TextDecoder("utf-8").decode(bytes);
}

export async function extractFromZipBuffer(
  buffer: Buffer,
  options?: { stripRoot?: boolean },
): Promise<ExtractionResult> {
  if (buffer.byteLength > MAX_REPO_SIZE_BYTES) {
    return {
      ok: false,
      error: `Repository exceeds the ${MAX_REPO_SIZE_MB} MB size limit.`,
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { ok: false, error: "Invalid or corrupted ZIP file." };
  }

  const allEntries = Object.values(zip.files);
  if (allEntries.length > MAX_ZIP_ENTRIES) {
    return { ok: false, error: "Archive contains too many entries." };
  }

  // Unsafe names (../, absolute, drive letters) are rejected before any
  // root stripping could turn them into innocent-looking paths.
  const entries = allEntries.filter(
    (entry) => !entry.dir && !isSymlink(entry) && isSafeRelativePath(entry.name),
  );
  const names = entries.map((entry) => normalizePath(entry.name));
  const root = options?.stripRoot ? commonRoot(names) : null;
  const candidates = entries.map((entry, i) => ({
    entry,
    relativePath: root ? names[i].slice(root.length) : names[i],
  }));

  let totalBytes = 0;

  try {
    const gitignoreEntry = candidates.find(
      (item) => item.relativePath === ".gitignore",
    );
    const gitignoreBytes = gitignoreEntry
      ? await readEntryLimited(gitignoreEntry.entry, MAX_FILE_SIZE_BYTES)
      : null;
    const gitignoreContent = gitignoreBytes
      ? (decodeText(gitignoreBytes) ?? undefined)
      : undefined;
    const gitignore = createGitignoreFilter(gitignoreContent);

    const keptEntries: typeof candidates = [];
    const skippedLargeFiles: string[] = [];
    // The limit bounds the work (reading, chunking, embeddings): only JS/TS
    // files are read and analyzed, so only they count. Other text files
    // (translations, styles, docs) are listed by name, never read or stored.
    let sourceCount = 0;

    for (const item of candidates) {
      if (!item.relativePath || shouldSkipPath(item.relativePath, gitignore)) {
        continue;
      }

      keptEntries.push(item);
      if (isSourceFile(item.relativePath) && ++sourceCount > MAX_FILE_COUNT) {
        return {
          ok: false,
          error: `Repository exceeds the ${MAX_FILE_COUNT} JS/TS file limit.`,
        };
      }
    }

    const allRelativePaths = keptEntries.map((item) => item.relativePath);
    const sourceFiles: ExtractedFile[] = [];

    // Also keep package.json for framework detection even if not a source file
    for (const item of keptEntries) {
      const isPackageJson =
        item.relativePath === "package.json" ||
        item.relativePath.endsWith("/package.json");
      if (!isSourceFile(item.relativePath) && !isPackageJson) continue;

      const bytes = await readEntryLimited(item.entry, MAX_FILE_SIZE_BYTES);
      if (!bytes) {
        skippedLargeFiles.push(item.relativePath);
        continue;
      }

      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_REPO_SIZE_BYTES) {
        return {
          ok: false,
          error: `Repository exceeds the ${MAX_REPO_SIZE_MB} MB size limit after filtering.`,
        };
      }

      const content = decodeText(bytes);
      if (content === null) continue;

      sourceFiles.push({
        relativePath: item.relativePath,
        content,
        sizeBytes: bytes.byteLength,
      });
    }

    const analyzable = sourceFiles.filter((file) =>
      isSourceFile(file.relativePath),
    );

    if (analyzable.length === 0) {
      return {
        ok: false,
        error:
          "No JavaScript/TypeScript source files found. Only JS/TS projects are supported.",
      };
    }

    // ADR-012: the root lockfile (always skipped as a file) is read only to
    // list the production dependencies. One too large or unreadable counts
    // as missing.
    const lockfileEntry = candidates.find((item) => LOCKFILE_NAMES.has(item.relativePath));
    const lockfileBytes = lockfileEntry ? await readEntryLimited(lockfileEntry.entry, MAX_LOCKFILE_BYTES) : null;
    const lockfileText = lockfileBytes ? decodeText(lockfileBytes) : null;
    const manifest = sourceFiles.find((file) => file.relativePath === "package.json")?.content;
    const dependencies = lockfileText ? parseNpmLockfile(lockfileText, manifest) : null;

    return {
      ok: true,
      sourceFiles,
      allRelativePaths,
      totalBytes,
      skippedLargeFiles,
      dependencies,
    };
  } catch {
    // Corrupt entry data (bad CRC, truncated stream, ...)
    return { ok: false, error: "Invalid or corrupted ZIP file." };
  }
}
