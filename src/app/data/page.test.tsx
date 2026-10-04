// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { EXPLAIN_MAX_CHARS, RAG_TOP_K } from "@/lib/limits";
import { REVIEW_BUDGET } from "@/modules/analysis";

import DataPage from "./page";

afterEach(cleanup);

describe("data page", () => {
  it("states the limits the code actually uses for what goes to Groq", () => {
    render(<DataPage />);

    expect(
      screen.getByText(new RegExp(`Up to ${REVIEW_BUDGET.maxChunks} pieces of your code`)),
    ).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(`${REVIEW_BUDGET.maxChars.toLocaleString("en-US")} characters in total`),
      ),
    ).toBeTruthy();
    expect(screen.getByText(new RegExp(`the ${RAG_TOP_K} pieces of code`))).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(`cut at ${EXPLAIN_MAX_CHARS.toLocaleString("en-US")} characters`),
      ),
    ).toBeTruthy();
  });

  it("warns that secrets in the code are sent as they are", () => {
    render(<DataPage />);

    expect(screen.getByText("Code is sent as it is.")).toBeTruthy();
  });

  it("links to Groq's data policy", () => {
    render(<DataPage />);

    const link = screen.getByRole("link", { name: "Groq's data policy" });
    expect(link.getAttribute("href")).toBe("https://console.groq.com/docs/your-data");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
