import path from "path";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

function getLanguage(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx") return TypeScript.tsx;
  if (ext === ".ts") return TypeScript.typescript;
  // .js / .jsx: the JavaScript grammar also parses JSX.
  return JavaScript;
}

/**
 * Tree-sitter syntax tree of a JS/TS source file (shared by chunking and
 * the function-size measure). The buffer grows with the file: the default
 * one rejects very long sources.
 */
export function parseSource(filePath: string, source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(getLanguage(filePath));
  return parser.parse(source, undefined, { bufferSize: Math.max(32 * 1024, source.length * 2) });
}
