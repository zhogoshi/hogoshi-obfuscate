import { createHash } from "node:crypto";
import { minify } from "terser";
import { parseCode } from "./classes.js";
import JavaScriptObfuscator from "javascript-obfuscator";

const BUNDLER_NAMES = [
  "webpackChunk_N_E", "__webpack_require__", "__webpack_modules__", "__webpack_exports__",
  "__NEXT_DATA__", "__next", "__next_f",
];

export const isModule = (code) => /^\s*(?:import|export)[\s{("']/m.test(code);

export async function compact(code, module) {
  const result = await minify(code, {
    module,
    compress: { passes: 2, defaults: true, drop_debugger: true },
    mangle: { toplevel: false, reserved: BUNDLER_NAMES },
    format: { comments: "some", ecma: 2020 },
  });
  if (typeof result.code !== "string" || !result.code.length) throw new Error("empty terser output");
  return result.code;
}

export function harden(code, module, seed) {
  const output = JavaScriptObfuscator.obfuscate(code, {
    seed: parseInt(createHash("sha256").update(`${seed}\0${code.length}`).digest("hex").slice(0, 8), 16),
    target: "browser",
    compact: true,
    simplify: true,
    identifierNamesGenerator: "mangled-shuffled",
    renameGlobals: false,
    renameProperties: false,
    transformObjectKeys: false,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.35,
    stringArray: true,
    stringArrayThreshold: 0.75,
    stringArrayEncoding: ["base64"],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayIndexShift: true,
    stringArrayCallsTransform: false,
    stringArrayWrappersCount: 1,
    deadCodeInjection: false,
    numbersToExpressions: false,
    splitStrings: false,
    unicodeEscapeSequence: false,
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    sourceMap: false,
    reservedNames: ["^webpack", "^__webpack", "^__next", "^next", "^self$", "^__NEXT_DATA__$"],
    reservedStrings: ["^[A-Za-z_$][\\w$]*$", "/_next/", "next/dist"],
  }).getObfuscatedCode();
  return module ? output : `(()=>{${output}})();`;
}

export const stripSourceMapComments = (text) => text.replace(/\n?\/[/*][#@] sourceMappingURL=[^\n]*?(?:\*\/)?\s*$/g, "");

export function unescapeSpaces(code) {
  const edits = [];
  const stack = [parseCode(code)];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === "Literal" && typeof node.value === "string" && node.raw.includes("\\x20")) {
      edits.push({ start: node.start, end: node.end, text: node.raw.replace(/\\(x20|[\s\S])/g, (match, char) => (char === "x20" ? " " : match)) });
      continue;
    }
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child]) if (item && typeof item.type === "string") stack.push(item);
    }
  }
  edits.sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(code.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(code.slice(cursor));
  return parts.join("");
}
