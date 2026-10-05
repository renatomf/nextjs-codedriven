import { describe, expect, it } from "vitest";

import { measureFunctions } from "@/lib/analysis/function-sizes";

const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n");

function sizes(relativePath: string, content: string) {
  return measureFunctions([{ relativePath, content }]).map(({ name, lines }) => [name, lines]);
}

// TD-31: function sizes come from the syntax tree, counted like ESLint's
// `max-lines-per-function` (first to last line, nested functions too).
describe("measureFunctions", () => {
  it("names declarations, arrows, methods, object properties and class fields", () => {
    const content = [
      "export function a() {}",
      "export const b = async (x: number) => x;",
      "class C {",
      "  m() {}",
      "  f = () => 1;",
      "}",
      "const o = { p: function () {} };",
      "items.map(() => 1);",
    ].join("\n");

    expect(sizes("src/x.ts", content)).toEqual([
      ["a", 1],
      ["b", 1],
      ["m", 1],
      ["f", 1],
      ["p", 1],
      ["anonymous", 1],
    ]);
  });

  it("counts nested functions on their own and inside their parent", () => {
    const content = ["function outer() {", "  const inner = () => {", "    return 1;", "  };", "}"].join("\n");

    expect(sizes("src/x.ts", content)).toEqual([
      ["outer", 5],
      ["inner", 3],
    ]);
  });

  it("is not fooled by braces in strings, comments or template literals", () => {
    const content = [
      "function f() {",
      '  const s = "}}}";',
      "  // }",
      "  const t = `${'{'}`;",
      "  return s + t;",
      "}",
    ].join("\n");

    expect(sizes("src/x.ts", content)).toEqual([["f", 6]]);
  });

  it("sizes a React component by its logic up to the JSX return, other functions whole", () => {
    const component = [
      "export function Page() {",
      "  const [a] = useState(0);",
      "  return (",
      "    <div>",
      lines(100, (i) => `      <p>${i}</p>`),
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const arrowComponent = ["const Item = () => (", "  <li>", lines(60, () => "    x"), "  </li>", ");"].join("\n");

    expect(sizes("src/Page.tsx", component)).toEqual([["Page", 3]]);
    expect(sizes("src/Item.jsx", arrowComponent)).toEqual([["Item", 1]]);
    // Not a component: lowercase, or not a .jsx/.tsx file.
    expect(sizes("src/page.tsx", component.replace("Page", "page"))[0]).toEqual(["page", 107]);
  });

  it("parses plain JavaScript with JSX (sized whole: only .jsx/.tsx files hold components)", () => {
    expect(sizes("src/app.js", "export default function App() {\n  return <main />;\n}\n")).toEqual([["App", 3]]);
  });
});
