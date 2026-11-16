import { createHash } from "node:crypto";
import { parseCode } from "../classes.js";
import { Program, Unsupported } from "./compile.js";
import { prelude } from "./runtime.js";

export const MARKER = "hogoshi:vm";

const isMarked = (node) =>
  node.type === "CallExpression" &&
  node.arguments.length === 2 &&
  node.arguments[0].type === "Literal" &&
  node.arguments[0].value === MARKER &&
  ["FunctionExpression", "ArrowFunctionExpression"].includes(node.arguments[1].type);

function findMarked(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (isMarked(node)) {
      found.push(node);
      continue;
    }
    for (const value of Object.values(node)) {
      if (!value || typeof value !== "object") continue;
      for (const item of Array.isArray(value) ? value : [value]) if (item && typeof item.type === "string") stack.push(item);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function replacement(fn, name, unit, free) {
  const thunks = [...free.keys()].map((variable) => `()=>${variable}`).join(",");
  const call = `${name}(${unit},hgArgs,this,[${thunks}])`;
  if (fn.type === "ArrowFunctionExpression") return `(...hgArgs)=>${call}`;
  return `function${fn.id ? ` ${fn.id.name}` : ""}(...hgArgs){return ${call}}`;
}

export function virtualize(code, seed) {
  const ast = parseCode(code);
  const marked = findMarked(ast);
  if (!marked.length) return { code, count: 0, skipped: [] };

  const hash = createHash("sha256").update(`${seed}\0vm`).digest();
  const name = `_${hash.subarray(0, 4).toString("hex")}`;
  const program = new Program();
  const edits = [];
  const skipped = [];

  for (const call of marked) {
    const fn = call.arguments[1];
    try {
      const unit = program.compile(fn);
      edits.push({ start: call.start, end: call.end, text: replacement(fn, name, unit, program.free) });
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      skipped.push(`offset ${call.start}: ${error.message}`);
    }
  }
  if (!edits.length) return { code, count: 0, skipped };

  const directives = ast.body.filter((node) => node.type === "ExpressionStatement" && node.directive);
  const insertAt = directives.length ? directives[directives.length - 1].end : 0;
  edits.push({ start: insertAt, end: insertAt, text: prelude(program, name, hash.readUInt32BE(4)) });
  edits.sort((a, b) => a.start - b.start);

  const parts = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(code.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(code.slice(cursor));
  return { code: parts.join(""), count: edits.length - 1, skipped };
}
