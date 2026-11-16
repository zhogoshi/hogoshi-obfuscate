import { argCount, BINARY, OPS, UNARY } from "./compile.js";

const BINARY_BODIES = { in: "a in b", instanceof: "a instanceof b" };

const CASES = {
  CONST: "s.push(K[c[pc++]]);break;",
  UNDEF: "s.push(void 0);break;",
  POP: "s.pop();break;",
  DUP: "s.push(s[s.length-1]);break;",
  DUP2: "{const n=s.length;s.push(s[n-2],s[n-1]);break}",
  LOAD: "{let d=c[pc++],x=r;while(d--)x=x.p;s.push(x.v[c[pc++]]);break}",
  STORE: "{let d=c[pc++],x=r;while(d--)x=x.p;x.v[c[pc++]]=s[s.length-1];break}",
  FREE: "s.push(f[c[pc++]]());break;",
  TYPEOF_FREE: "{const j=c[pc++];let y;try{y=typeof f[j]()}catch{y='undefined'}s.push(y);break}",
  GET: "{const k=s.pop(),o=s.pop();s.push(o[k]);break}",
  SET: "{const v=s.pop(),k=s.pop(),o=s.pop();o[k]=v;s.push(v);break}",
  DEL: "{const k=s.pop(),o=s.pop();s.push(delete o[k]);break}",
  CALL: "{const n=c[pc++],a=s.splice(s.length-n,n),g=s.pop(),t=s.pop();s.push(Reflect.apply(g,t,a));break}",
  NEW: "{const n=c[pc++],a=s.splice(s.length-n,n),g=s.pop();s.push(Reflect.construct(g,a));break}",
  BIN: "{const y=s.pop(),x=s.pop();s.push(B[c[pc++]](x,y));break}",
  UN: "s.push(N[c[pc++]](s.pop()));break;",
  TOSTR: "s.push(`${s.pop()}`);break;",
  TONUM: "s.push(+s.pop());break;",
  JMP: "pc=c[pc];break;",
  JF: "{const j=c[pc++];if(!s.pop())pc=j;break}",
  JT: "{const j=c[pc++];if(s.pop())pc=j;break}",
  JFK: "{const j=c[pc++];if(!s[s.length-1])pc=j;else s.pop();break}",
  JTK: "{const j=c[pc++];if(s[s.length-1])pc=j;else s.pop();break}",
  JNK: "{const j=c[pc++];if(s[s.length-1]!=null)pc=j;else s.pop();break}",
  OPT: "{const j=c[pc++];if(s[s.length-1]==null){s[s.length-1]=void 0;pc=j}break}",
  OPTC: "{const j=c[pc++];if(s[s.length-1]==null){s.length-=2;s.push(void 0);pc=j}break}",
  ARR: "{const n=c[pc++];s.push(s.splice(s.length-n,n));break}",
  OBJ: "{const n=c[pc++]*2,a=s.splice(s.length-n,n),o={};for(let i=0;i<n;i+=2)o[a[i]]=a[i+1];s.push(o);break}",
  FUNC: "{const u=U[c[pc++]],q=r;s.push(u.w?(...a)=>run(u,a,q.t,f,q):function(...a){return run(u,a,this,f,q)});break}",
  THIS: "s.push(r.t);break;",
  REGEX: "s.push(new RegExp(K[c[pc++]],K[c[pc++]]));break;",
  RET: "return s.pop();",
  THROW: "throw s.pop();",
  TRY: "h.push([c[pc++],s.length]);break;",
  ENDTRY: "h.pop();break;",
};

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(count, seed) {
  const order = Array.from({ length: count }, (_, i) => i);
  const random = mulberry32(seed);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const literal = (value) => (typeof value === "string" ? JSON.stringify(value) : Object.is(value, -0) ? "-0" : String(value));

export function remap(program, seed) {
  const numbering = shuffled(OPS.length, seed);
  const units = program.units.map((unit) => {
    const code = [];
    for (let i = 0; i < unit.code.length; ) {
      const width = argCount(OPS[unit.code[i]]);
      code.push(numbering[unit.code[i]], ...unit.code.slice(i + 1, i + 1 + width));
      i += 1 + width;
    }
    return { ...unit, code };
  });
  return { units, numbering };
}

export function prelude(program, name, seed) {
  const { units, numbering } = remap(program, seed);
  const cases = OPS.map((op) => `case ${numbering[OPS.indexOf(op)]}:${CASES[op]}`).join("");
  const binary = BINARY.map((op) => `(a,b)=>${BINARY_BODIES[op] ?? `a${op}b`}`).join(",");
  const unary = UNARY.map((op) => `(a)=>${op === "typeof" || op === "void" ? `${op} a` : `${op}a`}`).join(",");
  const unitSource = units.map((unit) => `{c:[${unit.code.join(",")}],n:${unit.n},a:${unit.a},w:${unit.w}}`).join(",");
  return (
    `const ${name}=(()=>{const K=[${program.consts.map(literal).join(",")}],U=[${unitSource}],B=[${binary}],N=[${unary}];` +
    `const run=(u,a,t,f,p)=>{const r={v:new Array(u.n),p,t,f};for(let i=0;i<u.a;i++)r.v[i]=a[i];` +
    `const c=u.c,s=[],h=[];let pc=0;for(;;){try{for(;;){switch(c[pc++]){${cases}}}}catch(e){if(!h.length)throw e;const q=h.pop();s.length=q[1];s.push(e);pc=q[0]}}};` +
    `return(i,a,t,f)=>run(U[i],a,t,f,null)})();`
  );
}
