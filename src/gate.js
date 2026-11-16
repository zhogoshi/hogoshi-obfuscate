import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { collectClasses, isBare, parseCode } from "./classes.js";
import { classify, walk } from "./inventory.js";

const MAP_COMMENT = /sourceMappingURL=/;

function balanced(css) {
  let depth = 0;
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char === "\\") {
      i += 1;
    } else if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
    } else if (char === '"' || char === "'") {
      i += 1;
      while (i < css.length && css[i] !== char) i += css[i] === "\\" ? 2 : 1;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

export function verify(root, { mode, changed, names }) {
  const problems = [];
  const assets = mode === "static-export" ? join(root, "_next") : root;
  const sheets = [];

  for (const rel of walk(root)) {
    const kind = classify(rel);
    const path = join(root, rel);
    if (kind === "map") problems.push(`source map published: ${rel}`);
    if (!["client-js", "runtime-js", "server-js", "css", "html"].includes(kind)) continue;
    const text = readFileSync(path, "utf8");
    if (MAP_COMMENT.test(text.slice(-300))) problems.push(`sourceMappingURL left: ${rel}`);

    if (kind.endsWith("js")) {
      if (changed.has(rel)) {
        try {
          parseCode(text);
        } catch (error) {
          problems.push(`does not parse: ${rel}: ${error.message}`);
        }
      }
    } else if (kind === "css") {
      sheets.push(text);
      if (!balanced(text)) problems.push(`unbalanced braces: ${rel}`);
      for (const match of text.matchAll(/url\(\s*["']?(?!data:|https?:|\/|#)([^"')\s]+)/g)) {
        const target = normalize(join(dirname(path), match[1].split(/[?#]/)[0]));
        if (!existsSync(target)) problems.push(`missing asset ${match[1]} in ${rel}`);
      }
    } else {
      for (const match of text.matchAll(/(?:href|src)="\/_next\/(?!image)([^"?#]+)/g)) {
        if (!existsSync(join(assets, decodeURIComponent(match[1])))) problems.push(`missing asset /_next/${match[1]} in ${rel}`);
      }
    }
  }

  if (names) {
    const left = collectClasses(sheets, []);
    for (const name of names.keys()) if (!isBare(name) && left.has(name)) problems.push(`class left unrenamed in CSS: ${name}`);
  }
  return problems;
}
