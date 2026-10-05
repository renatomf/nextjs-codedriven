import { describe, expect, it } from "vitest";

import { riskScore, sampleForReview, snippetChars, type ReviewBudget } from "./sampling";

const chunk = (filePath: string, startLine = 1, size = 100) => ({
  filePath,
  startLine,
  content: "x".repeat(size),
});

const files = (sample: Array<{ filePath: string }>) => [...new Set(sample.map((c) => c.filePath))];

const budget = (maxChunks: number, maxChars = 100_000): ReviewBudget => ({
  maxChunks,
  maxChars,
  chunkChars: 2_500,
});

describe("sampleForReview", () => {
  it("reaches files far down the alphabet instead of filling up with the first ones", () => {
    const early = Array.from({ length: 30 }, (_, i) => chunk(`src/components/w${String(i).padStart(2, "0")}.tsx`));
    const sample = sampleForReview([...early, chunk("src/utils/orders.ts")], budget(5));

    expect(files(sample)).toContain("src/utils/orders.ts");
  });

  it("puts server logic before other logic, UI and configuration", () => {
    const sample = sampleForReview(
      [
        chunk("next.config.ts"),
        chunk("src/components/button.tsx"),
        chunk("src/lib/format.ts"),
        chunk("src/server/users.ts"),
      ],
      budget(1),
    );

    // Alphabetical order alone would pick src/lib/format.ts.
    expect(files(sample)).toEqual(["src/server/users.ts"]);
    expect(files(sampleForReview([chunk("next.config.ts"), chunk("src/components/button.tsx"), chunk("src/lib/format.ts")], budget(1)))).toEqual(["src/lib/format.ts"]);
    expect(files(sampleForReview([chunk("next.config.ts"), chunk("src/components/button.tsx")], budget(1)))).toEqual(["src/components/button.tsx"]);
    // Type declarations hold no logic, whatever their name says.
    expect(files(sampleForReview([chunk("src/types/next-auth.d.ts"), chunk("src/components/button.tsx")], budget(1)))).toEqual(["src/components/button.tsx"]);
  });

  it.each([
    "frontend/src/app/payment/payment.component.ts",
    "frontend/src/app/Services/payment.service.ts",
    "client/src/api/auth.ts",
    "src/app/login/login.component.ts",
    "data/static/codefixes/loginAdmin_1.ts",
    "public/js/session.js",
    "app/assets/js/auth-tour.js",
  ])("does not give browser code or served files server priority from its path: %s", (uiFile) => {
    const code = "export const pay = (session) => session.token;";
    const sample = sampleForReview(
      [
        { filePath: uiFile, startLine: 1, content: code },
        { filePath: "src/lib/orders.ts", startLine: 1, content: code },
      ],
      budget(1),
    );

    expect(files(sample)).toEqual(["src/lib/orders.ts"]);
  });

  it.each(["src/payments/payments.service.ts", "apps/api/src/auth/auth.module.ts", "server/routes/auth.ts"])(
    "keeps server priority for backend code: %s",
    (serverFile) => {
      const code = "export const pay = (session) => session.token;";
      const sample = sampleForReview(
        [
          { filePath: "src/lib/orders.ts", startLine: 1, content: code },
          { filePath: serverFile, startLine: 1, content: code },
        ],
        budget(1),
      );

      expect(files(sample)).toEqual([serverFile]);
    },
  );

  it("takes one file per directory in turn", () => {
    const sample = sampleForReview(
      [chunk("src/a/one.ts"), chunk("src/a/two.ts"), chunk("src/a/three.ts"), chunk("src/b/one.ts")],
      budget(2),
    );

    expect(files(sample)).toEqual(["src/a/one.ts", "src/b/one.ts"]);
  });

  it("takes one chunk of every file before a second of any (by line when none is riskier)", () => {
    const sample = sampleForReview(
      [chunk("src/a.ts", 1), chunk("src/a.ts", 50), chunk("src/b.ts", 1)],
      budget(2),
    );

    expect(sample.map((c) => `${c.filePath}:${c.startLine}`)).toEqual(["src/a.ts:1", "src/b.ts:1"]);
  });

  it("takes the chunk with risk signals of a file, not its imports", () => {
    const code = (startLine: number, content: string) => ({ filePath: "app/routes/pay.js", startLine, content });
    const sample = sampleForReview(
      [
        code(1, 'const express = require("express");'),
        code(5, "function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}"),
        code(20, "app.post('/pay', (req, res) => {\n  const amount = eval(req.body.amount);\n});"),
      ],
      budget(1),
    );

    expect(sample.map((c) => c.startLine)).toEqual([20]);
  });

  it("puts a file with risk signals before one without any, even from a lower level", () => {
    const sample = sampleForReview(
      [
        { filePath: "src/server/about.ts", startLine: 1, content: "export const title = 'About';" },
        {
          filePath: "src/lib/user-store.ts",
          startLine: 1,
          content: "export const matches = (user, password) => user.password === password;",
        },
      ],
      budget(1),
    );

    expect(files(sample)).toEqual(["src/lib/user-store.ts"]);
  });

  it("puts the riskiest file first within the same level", () => {
    const sample = sampleForReview(
      [
        { filePath: "src/lib/a-cookies.ts", startLine: 1, content: "export const read = (cookies) => cookies.get('x');" },
        {
          filePath: "src/lib/z-run.ts",
          startLine: 1,
          content: "export const run = (req) => eval(req.body.code) && fetch(req.query.url);",
        },
      ],
      budget(1),
    );

    // Alphabetical order alone would pick a-cookies.ts.
    expect(files(sample)).toEqual(["src/lib/z-run.ts"]);
  });

  it("leaves tests out, unless there is nothing else", () => {
    expect(files(sampleForReview([chunk("src/a.test.ts"), chunk("e2e/flow.spec.ts"), chunk("src/a.ts")], budget(5)))).toEqual(["src/a.ts"]);
    expect(files(sampleForReview([chunk("src/a.test.ts")], budget(5)))).toEqual(["src/a.test.ts"]);
  });

  it("stays within the character budget, skipping chunks that do not fit", () => {
    const [a, b, c] = [chunk("src/api/a.ts", 1, 900), chunk("src/lib/b.ts", 1, 300), chunk("src/lib/c.ts", 1, 100)];
    const sample = sampleForReview([a, b, c], budget(10, snippetChars(a) + snippetChars(c)));

    expect(files(sample)).toEqual(["src/api/a.ts", "src/lib/c.ts"]);
  });

  it("counts a long chunk only up to the part that is sent", () => {
    const [a, b] = [chunk("src/a.ts", 1, 10_000), chunk("src/b.ts", 1, 10_000)];
    const sample = sampleForReview([a, b], budget(10, snippetChars(a) + snippetChars(b)));

    expect(snippetChars(a)).toBeLessThan(3_000);
    expect(sample).toHaveLength(2);
  });

  it("returns the sample in path and line order, the same every time", () => {
    const input = [chunk("src/z/api.ts", 1), chunk("src/a/lib.ts", 9), chunk("src/a/lib.ts", 1)];
    const first = sampleForReview(input, budget(10));

    expect(first.map((c) => `${c.filePath}:${c.startLine}`)).toEqual(["src/a/lib.ts:1", "src/a/lib.ts:9", "src/z/api.ts:1"]);
    expect(sampleForReview([...input].reverse(), budget(10))).toEqual(first);
  });

  it("returns nothing for no chunks", () => {
    expect(sampleForReview([], budget(5))).toEqual([]);
  });
});

describe("riskScore", () => {
  it.each([
    ["request input", "const { id } = req.params;"],
    ["App Router input", "const body = await request.json();"],
    ["code execution", "const value = eval(input);"],
    ["raw SQL", "await prisma.$queryRawUnsafe(sql);"],
    ["HTML injection", "<div dangerouslySetInnerHTML={{ __html: html }} />"],
    ["a redirect", "return res.redirect(next);"],
    ["an outbound request", "const page = await fetch(url);"],
    ["file access", "const text = fs.readFileSync(path);"],
    ["passwords", "if (user.password === password) {"],
    ["sessions", "const session = await auth();"],
    ["ORM data access", "await db.update(projects).set({ status }).where(eq(projects.id, id));"],
    ["Prisma data access", "const user = await prisma.user.findUnique({ where: { id } });"],
    ["an auth library", "export default NextAuth(authConfig).auth;"],
    ["secrets and configuration", "const url = process.env.DATABASE_URL;"],
  ])("counts %s", (_, content) => {
    expect(riskScore(content)).toBeGreaterThan(0);
  });

  it("is 0 for code without input, dangerous calls or auth", () => {
    expect(riskScore("export function total(items) {\n  return items.length;\n}")).toBe(0);
    expect(riskScore('import { Button } from "@/components/ui/button";')).toBe(0);
  });

  it("counts kinds of signal, not repetitions", () => {
    expect(riskScore("eval(req.body.a); eval(req.body.b);")).toBe(2);
  });
});
