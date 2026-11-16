const CSS_WS = " \t\n\r\f";

export function minifyCss(css) {
  let out = "";
  let depth = 0;
  let i = 0;
  const n = css.length;
  const prevChar = () => (out.length ? out[out.length - 1] : "");

  while (i < n) {
    const ch = css[i];

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (css[j] === "\\") { j += 2; continue; }
        if (css[j] === ch) break;
        j += 1;
      }
      out += css.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      if (end !== -1 && /^!|@preserve|@license/i.test(css.slice(i + 2, end).trim())) out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "u" && /^url\(/i.test(css.slice(i, i + 4)) && !/[A-Za-z0-9_-]$/.test(prevChar())) {
      const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"][^)]*?))\s*\)/i.exec(css.slice(i));
      if (m) {
        const inner = m[1] ?? m[2] ?? m[3] ?? "";
        out += /^[\w\-./%#?=&+:~]+$/.test(inner) ? `url(${inner})` : m[0];
        i += m[0].length;
        continue;
      }
    }

    if (CSS_WS.includes(ch)) {
      let j = i;
      while (j < n && CSS_WS.includes(css[j])) j += 1;
      const prev = prevChar();
      const next = css[j] ?? "";
      const dropBefore = "{};>,+~:,".includes(prev);
      const dropAfter = "{};>,+~,".includes(next);
      if (depth === 0 && (dropBefore || dropAfter)) { i = j; continue; }
      out += " ";
      i = j;
      continue;
    }

    if (ch === ";") {
      let j = i + 1;
      while (j < n && CSS_WS.includes(css[j])) j += 1;
      if (css[j] === "}" && depth === 0) { i += 1; continue; }
      out += ";";
      i += 1;
      continue;
    }

    if (ch === "#") {
      const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/.exec(css.slice(i));
      const prev = prevChar();
      if (m && depth === 0 && (prev === ":" || prev === "(")) {
        const h = m[1];
        if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5] && (h.length === 6 || h[6] === h[7])) {
          out += `#${h[0]}${h[2]}${h[4]}${h.length === 8 ? h[6] : ""}`;
          i += m[0].length;
          continue;
        }
      }
    }

    if (ch === "0" && css[i + 1] === "." && !/[A-Za-z0-9_.]/.test(prevChar())) {
      out += ".";
      i += 2;
      continue;
    }

    if (ch === "(") { depth += 1; out += ch; i += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); out += ch; i += 1; continue; }

    out += ch;
    i += 1;
  }
  return out.trim();
}


const HTML_RAW = /^<(pre|textarea|script|style)(?=[\s>/])/i;

function copyTag(html, i) {
  const n = html.length;
  let j = i + 1;
  while (j < n) {
    const c = html[j];
    if (c === '"' || c === "'") {
      j += 1;
      while (j < n && html[j] !== c) j += 1;
      j += 1;
      continue;
    }
    if (c === ">") return j + 1;
    j += 1;
  }
  return n;
}

export function minifyHtml(html) {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    const raw = html[i] === "<" && HTML_RAW.exec(html.slice(i));
    if (raw) {
      const tag = raw[1].toLowerCase();
      const openEnd = copyTag(html, i);
      const m = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(openEnd));
      const stop = m ? openEnd + m.index + m[0].length : n;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    if (html[i] === "<") {
      const stop = copyTag(html, i);
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    const next = html.indexOf("<", i);
    const stop = next === -1 ? n : next;
    out += html.slice(i, stop).replace(/\s+/g, " ");
    i = stop;
  }
  return out;
}
