import type Parser from "tree-sitter";

import { parseSource } from "./syntax-tree";

export type CodeChunkDraft = {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
};

const TARGET_MIN_TOKENS = 200;
const TARGET_MAX_TOKENS = 400;
const OVERLAP_TOKENS = 50;

const CHUNK_NODE_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "method_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration",
  "variable_declaration",
  "export_statement",
  "expression_statement",
]);

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function splitOversized(
  filePath: string,
  content: string,
  startLine: number,
): CodeChunkDraft[] {
  const chunks: CodeChunkDraft[] = [];
  const maxChars = TARGET_MAX_TOKENS * 4;
  const overlapChars = OVERLAP_TOKENS * 4;

  let index = 0;
  let lineOffset = 0;

  while (index < content.length) {
    const end = Math.min(content.length, index + maxChars);
    const slice = content.slice(index, end);
    const sliceLines = slice.split("\n");
    const chunkStartLine = startLine + lineOffset;
    const chunkEndLine = chunkStartLine + sliceLines.length - 1;

    chunks.push({
      filePath,
      content: slice.trimEnd(),
      startLine: chunkStartLine,
      endLine: chunkEndLine,
    });

    if (end >= content.length) break;

    const nextIndex = Math.max(index + 1, end - overlapChars);
    const advanced = content.slice(index, nextIndex);
    lineOffset += advanced.split("\n").length - 1;
    index = nextIndex;
  }

  return chunks.filter((chunk) => chunk.content.trim().length > 0);
}

function collectNodes(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];

  function visit(node: Parser.SyntaxNode, depth: number) {
    if (CHUNK_NODE_TYPES.has(node.type)) {
      // Prefer the inner declaration for export wrappers when possible
      if (node.type === "export_statement") {
        const inner =
          node.namedChildren.find((child) =>
            CHUNK_NODE_TYPES.has(child.type),
          ) ?? null;
        if (inner) {
          visit(inner, depth + 1);
          return;
        }
      }

      results.push(node);

      // Also chunk methods inside classes separately
      if (
        node.type === "class_declaration" ||
        node.type === "abstract_class_declaration"
      ) {
        for (const child of node.namedChildren) {
          if (child.type === "class_body") {
            for (const member of child.namedChildren) {
              if (member.type === "method_definition") {
                results.push(member);
              }
            }
          }
        }
      }
      return;
    }

    if (depth < 4) {
      for (const child of node.namedChildren) {
        visit(child, depth + 1);
      }
    }
  }

  visit(root, 0);
  return results;
}

function dedupeNodes(nodes: Parser.SyntaxNode[]): Parser.SyntaxNode[] {
  const seen = new Set<string>();
  const output: Parser.SyntaxNode[] = [];

  for (const node of nodes) {
    const key = `${node.startIndex}:${node.endIndex}:${node.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(node);
  }

  return output.sort((a, b) => a.startIndex - b.startIndex);
}

/** Chunk a single source file using Tree-sitter AST boundaries. */
export function chunkSourceFile(
  filePath: string,
  source: string,
): CodeChunkDraft[] {
  if (!source.trim()) return [];

  const tree = parseSource(filePath, source);
  const nodes = dedupeNodes(collectNodes(tree.rootNode));

  if (nodes.length === 0) {
    // Fallback: whole file (or split if huge)
    if (estimateTokens(source) > TARGET_MAX_TOKENS) {
      return splitOversized(filePath, source, 1);
    }
    return [
      {
        filePath,
        content: source,
        startLine: 1,
        endLine: source.split("\n").length,
      },
    ];
  }

  const drafts: CodeChunkDraft[] = [];

  for (const node of nodes) {
    const content = source.slice(node.startIndex, node.endIndex).trim();
    if (!content) continue;

    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const tokens = estimateTokens(content);

    if (tokens > TARGET_MAX_TOKENS) {
      drafts.push(...splitOversized(filePath, content, startLine));
      continue;
    }

    // Skip tiny noise (very small declarations), unless nothing else exists
    if (tokens < 20 && node.type === "expression_statement") continue;

    drafts.push({ filePath, content, startLine, endLine });
  }

  // Merge adjacent tiny chunks toward the 200-token target when cheap
  return mergeSmallChunks(drafts);
}

function mergeSmallChunks(chunks: CodeChunkDraft[]): CodeChunkDraft[] {
  if (chunks.length <= 1) return chunks;

  const merged: CodeChunkDraft[] = [];
  let current: CodeChunkDraft | null = null;

  for (const chunk of chunks) {
    if (!current) {
      current = { ...chunk };
      continue;
    }

    const sameFile = current.filePath === chunk.filePath;
    const combined: string = `${current.content}\n\n${chunk.content}`;
    const combinedTokens = estimateTokens(combined);

    if (
      sameFile &&
      estimateTokens(current.content) < TARGET_MIN_TOKENS &&
      combinedTokens <= TARGET_MAX_TOKENS
    ) {
      current = {
        filePath: current.filePath,
        content: combined,
        startLine: current.startLine,
        endLine: chunk.endLine,
      };
    } else {
      merged.push(current);
      current = { ...chunk };
    }
  }

  if (current) merged.push(current);
  return merged;
}

/** Chunk every provided source file. */
export function chunkProjectFiles(
  files: { relativePath: string; content: string }[],
): CodeChunkDraft[] {
  const all: CodeChunkDraft[] = [];
  for (const file of files) {
    all.push(...chunkSourceFile(file.relativePath, file.content));
  }
  return all;
}
