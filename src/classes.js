import { createHash } from "node:crypto";
import { parse } from "acorn";

export const SENTINEL = "__hogoshi_class_map__";
export const DEFAULT_KEEP = [/^recharts-/, /^sonner/, /^(?:dark|light)$/, /^__next/];

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALPHABET = `${LETTERS}0123456789`;
const CLASS_KEY = /^(?:class|className|classNames|[A-Za-z]*ClassName)$/;
const ESCAPE = String.raw`\\(?:[0-9a-fA-F]{1,6}[ \t\n]?|[^\n0-9a-fA-F])`;
const FIRST = String.raw`(?:[A-Za-z_-]|[^\x00-\x7f]|${ESCAPE})`;
const REST = String.raw`(?:[\w-]|[^\x00-\x7f]|${ESCAPE})`;
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const SELECTOR_TOKEN = new RegExp(String.raw`${QUOTED}|\[(?:[^\]"'\\]|\\.|${QUOTED})*\]|(?<![0-9])\.(${FIRST}${REST}*)`, "g");
const SKIPPED_SCRIPT = /type=["'](?:application\/(?:ld\+)?json|importmap|speculationrules)["']/;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);

export const isBare = (token) => /^[A-Za-z]+$/.test(token);

const unescape = (text) =>
  text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([\s\S]))/g, (_, hex, char) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : char));

const skipString = (text, from) => {
  let i = from + 1;
  while (i < text.length && text[i] !== text[from]) i += text[i] === "\\" ? 2 : 1;
  return i + 1;
};

export function rulePreludes(css) {
  const ranges = [];
  let start = 0;
  let i = 0;
  while (i < css.length) {
    const char = css[i];
    if (char === '"' || char === "'") {
      i = skipString(css, i);
    } else if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
    } else if (char === "\\") {
      i += 2;
    } else {
      if (char === "{") {
        if (!css.slice(start, i).trimStart().startsWith("@")) ranges.push([start, i]);
        start = i + 1;
      } else if (char === "}" || char === ";") {
        start = i + 1;
      }
      i += 1;
    }
  }
  return ranges;
}

export function collectClasses(sheets, keep = DEFAULT_KEEP) {
  const found = new Set();
  for (const css of sheets) {
    for (const [start, end] of rulePreludes(css)) {
      for (const match of css.slice(start, end).matchAll(SELECTOR_TOKEN)) {
        if (match[1] === undefined) continue;
        const name = unescape(match[1]);
        if (!/\s/.test(name) && !keep.some((pattern) => pattern.test(name))) found.add(name);
      }
    }
  }
  return found;
}

function deriveName(salt, name, attempt, length) {
  const bytes = createHash("sha512").update(`${salt}\0${attempt}\0${name}`).digest();
  let next = LETTERS[bytes[0] % LETTERS.length];
  for (let i = 1; i < length; i += 1) next += ALPHABET[bytes[i % bytes.length] % ALPHABET.length];
  return next;
}

export function createNames(classes, { salt = "", length = 4 } = {}) {
  const names = new Map();
  const used = new Set();
  for (const name of [...classes].sort()) {
    let attempt = 0;
    let next = deriveName(salt, name, attempt, length);
    while (used.has(next)) next = deriveName(salt, name, (attempt += 1), length);
    used.add(next);
    names.set(name, next);
  }
  return names;
}

export function rewriteCss(css, names) {
  let out = "";
  let last = 0;
  for (const [start, end] of rulePreludes(css)) {
    out += css.slice(last, start);
    out += css.slice(start, end).replace(SELECTOR_TOKEN, (match, id) => {
      if (id === undefined) return match;
      const name = unescape(id);
      const next = names.get(name);
      if (!next) return match;
      return isBare(name) ? `:is(${match},.${next})` : `.${next}`;
    });
    last = end;
  }
  return out + css.slice(last);
}

export function parseCode(code) {
  const options = { ecmaVersion: "latest", allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return parse(code, { ...options, sourceType: "script" });
  } catch {
    return parse(code, { ...options, sourceType: "module" });
  }
}

const quote = (value) => JSON.stringify(value).replaceAll("</", "<\\/");

export function createRewriter(names) {
  const swap = (text) => text.replace(/\S+/g, (token) => names.get(token) ?? token);
  const swapAttribute = (text) => text.replace(/\S+/g, (token) => names.get(decode(token)) ?? token);
  const table = [...names].flat().join(" ");

  const classes = (value, inClass) => {
    if (value.length > 20000) return null;
    const tokens = value.match(/\S+/g);
    if (!tokens) return null;
    const hits = tokens.filter((token) => names.has(token));
    if (!hits.length) return null;
    if (tokens.length === 1) return inClass || !isBare(tokens[0]) ? swap(value) : null;
    return hits.length * 2 >= tokens.length && (inClass || hits.some((token) => !isBare(token))) ? swap(value) : null;
  };

  const flight = (value) => value.replace(/"(class|className)":"((?:[^"\\]|\\.)*)"/g, (_, key, text) => `"${key}":"${swap(text)}"`);

  const template = (raw, index, count, inClass) => {
    const last = index === count - 1;
    const head = index > 0 && !/^\s/.test(raw) ? raw.match(/^\S*/)[0] : "";
    const tail = !last && !/\s$/.test(raw) ? raw.match(/\S*$/)[0] : "";
    if (head.length + tail.length > raw.length) return null;
    const middle = raw.slice(head.length, raw.length - tail.length);
    const next = classes(middle, inClass);
    return next === null ? null : head + next + tail;
  };

  const js = (code) => {
    const edits = [];
    const stack = [[parseCode(code), false]];
    while (stack.length) {
      const [node, inClass] = stack.pop();
      if (node.type === "Literal") {
        if (typeof node.value !== "string") continue;
        let next = null;
        if (node.value === SENTINEL) next = table;
        else next = classes(node.value, inClass) ?? (node.value.includes('"className":') ? flight(node.value) : null);
        if (next !== null && next !== node.value) edits.push({ start: node.start, end: node.end, text: quote(next) });
        continue;
      }
      if (node.type === "TemplateLiteral") {
        node.quasis.forEach((quasi, index) => {
          const next = template(quasi.value.raw, index, node.quasis.length, inClass);
          if (next !== null && next !== quasi.value.raw) edits.push({ start: quasi.start, end: quasi.end, text: next });
        });
        for (const expression of node.expressions) stack.push([expression, inClass]);
        continue;
      }
      const keyName = node.type === "Property" && !node.computed ? (node.key.name ?? node.key.value) : null;
      for (const [key, child] of Object.entries(node)) {
        if (!child || typeof child !== "object") continue;
        if (node.type === "Property" && key === "key" && !node.computed) continue;
        const flag = keyName !== null && key === "value" && CLASS_KEY.test(String(keyName)) ? true : inClass;
        for (const item of Array.isArray(child) ? child : [child]) if (item && typeof item.type === "string") stack.push([item, flag]);
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
  };

  const html = (source) =>
    source
      .replace(/(\sclass=")([^"]*)"/g, (_, prefix, value) => `${prefix}${swapAttribute(value)}"`)
      .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (match, attrs, body) =>
        !body.trim() || SKIPPED_SCRIPT.test(attrs) ? match : `<script${attrs}>${js(body)}</script>`,
      )
      .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/g, (_, attrs, body) => `<style${attrs}>${rewriteCss(body, names)}</style>`);

  return { css: (source) => rewriteCss(source, names), js, html, flight };
}
