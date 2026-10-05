import type Parser from "tree-sitter";

import type { FunctionSize, SourceFile } from "@/modules/analysis";

import { parseSource } from "./syntax-tree";

// Every kind of function the grammars produce: declarations, expressions,
// arrows and class/object methods (nested ones included, as ESLint's
// `max-lines-per-function` counts them).
const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

const JSX_NODE_TYPES = new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);

function functionName(node: Parser.SyntaxNode): string {
  const own = node.childForFieldName("name");
  if (own) return own.text;
  const parent = node.parent;
  if (!parent) return "anonymous";
  // `const f = () => …`, `{ f: () => … }`, `f = () => …`, class field `f = () => …`.
  const named =
    parent.type === "variable_declarator" || parent.type === "public_field_definition"
      ? parent.childForFieldName("name")
      : parent.type === "pair"
        ? parent.childForFieldName("key")
        : parent.type === "assignment_expression"
          ? parent.childForFieldName("left")
          : null;
  return named?.text ?? "anonymous";
}

function isJsx(expression: Parser.SyntaxNode | undefined): boolean {
  let value = expression;
  while (value?.type === "parenthesized_expression") value = value.namedChildren[0];
  return value !== undefined && JSX_NODE_TYPES.has(value.type);
}

/**
 * Lines of a function. A React component (PascalCase, in a .jsx/.tsx file)
 * is sized by its logic up to its last JSX `return`, not by its markup:
 * 100 lines of JSX are not complexity (TD-31).
 */
function functionLines(filePath: string, node: Parser.SyntaxNode, name: string): number {
  const start = node.startPosition.row;
  const whole = node.endPosition.row - start + 1;
  if (!/\.[jt]sx$/i.test(filePath) || !/^[A-Z]/.test(name)) return whole;
  const body = node.childForFieldName("body");
  if (!body) return whole;
  // `() => <div>…</div>`: no logic before the markup.
  if (body.type !== "statement_block") return isJsx(body) ? 1 : whole;
  const lastReturn = body.namedChildren.findLast((child) => child.type === "return_statement");
  return lastReturn && isJsx(lastReturn.namedChildren[0])
    ? lastReturn.startPosition.row - start + 1
    : whole;
}

/** Size of every function in the files, from the syntax tree (TD-31, TD-50). */
export function measureFunctions(files: SourceFile[]): FunctionSize[] {
  const sizes: FunctionSize[] = [];
  for (const file of files) {
    if (!file.content.trim()) continue;
    const visit = (node: Parser.SyntaxNode) => {
      if (FUNCTION_NODE_TYPES.has(node.type)) {
        const name = functionName(node);
        sizes.push({ filePath: file.relativePath, name, lines: functionLines(file.relativePath, node, name) });
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(parseSource(file.relativePath, file.content).rootNode);
  }
  return sizes;
}
