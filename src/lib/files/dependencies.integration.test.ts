import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadProjectDependencies, persistProjectFiles } from "@/lib/files/storage";
import { createProjectWithData, createUser, deleteUsers } from "@/test/integration/factories";

// ADR-012 against a real Postgres: the lockfile's production dependencies are
// stored with the files, replaced on every import and read only by the owner.

const created: string[] = [];
let owner: string;
let stranger: string;

beforeAll(async () => {
  owner = await createUser();
  stranger = await createUser();
  created.push(owner, stranger);
});

afterAll(async () => {
  await deleteUsers(created);
});

const files = [{ relativePath: "src/a.ts", content: "export {};", sizeBytes: 10 }];
const express = { name: "express", version: "4.17.1", direct: true };
const qs = { name: "qs", version: "6.7.0", direct: false };

describe("project dependencies", () => {
  it("is null for a project whose lockfile was never read", async () => {
    const projectId = await createProjectWithData(owner, crypto.randomUUID());

    expect(await loadProjectDependencies(owner, projectId)).toBeNull();
  });

  it("stores the dependencies with the files and replaces them on the next import", async () => {
    const projectId = await createProjectWithData(owner, crypto.randomUUID());

    await persistProjectFiles(owner, projectId, files, [express, qs]);
    expect(await loadProjectDependencies(owner, projectId)).toEqual({
      lockfileFound: true,
      dependencies: expect.arrayContaining([express, qs]),
    });

    // Re-imported without a lockfile: none left, and "no lockfile" is known.
    await persistProjectFiles(owner, projectId, files, null);
    expect(await loadProjectDependencies(owner, projectId)).toEqual({ lockfileFound: false, dependencies: [] });
  });

  it("never returns another user's dependencies (IDOR)", async () => {
    const projectId = await createProjectWithData(owner, crypto.randomUUID());
    await persistProjectFiles(owner, projectId, files, [express]);

    expect(await loadProjectDependencies(stranger, projectId)).toBeNull();
    await expect(persistProjectFiles(stranger, projectId, files, [qs])).rejects.toThrow("Project not found");
    expect((await loadProjectDependencies(owner, projectId))?.dependencies).toEqual([express]);
  });
});
