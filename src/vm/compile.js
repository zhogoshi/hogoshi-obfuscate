export const OPS = [
  "CONST", "UNDEF", "POP", "DUP", "DUP2", "LOAD", "STORE", "FREE", "TYPEOF_FREE", "GET", "SET", "DEL", "CALL", "NEW",
  "BIN", "UN", "TOSTR", "TONUM", "JMP", "JF", "JT", "JFK", "JTK", "JNK", "OPT", "OPTC", "ARR", "OBJ", "FUNC", "THIS",
  "REGEX", "RET", "THROW", "TRY", "ENDTRY",
];

export const BINARY = ["+", "-", "*", "/", "%", "**", "==", "!=", "===", "!==", "<", "<=", ">", ">=", "<<", ">>", ">>>", "&", "|", "^", "in", "instanceof"];
export const UNARY = ["-", "+", "!", "~", "typeof", "void"];

const ARGS = {
  UNDEF: 0, POP: 0, DUP: 0, DUP2: 0, GET: 0, SET: 0, DEL: 0, TOSTR: 0, TONUM: 0, THIS: 0, RET: 0, THROW: 0, ENDTRY: 0,
  LOAD: 2, STORE: 2, REGEX: 2,
};

export const argCount = (name) => ARGS[name] ?? 1;

export class Unsupported extends Error {}

const unsupported = (what) => {
  throw new Unsupported(what);
};

const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);
const LOOPS = new Set(["ForStatement", "WhileStatement", "DoWhileStatement"]);

function children(node) {
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || !value || typeof value !== "object") continue;
    for (const item of Array.isArray(value) ? value : [value]) if (item && typeof item.type === "string") found.push(item);
  }
  return found;
}

function declare(scope, name, kind, inLoop) {
  const existing = scope.names.get(name);
  if (existing) {
    if (!["var", "param"].includes(kind) || !["var", "param"].includes(existing.kind)) unsupported(`duplicate binding ${name}`);
    return;
  }
  scope.names.set(name, { index: scope.size, kind, inLoop });
  scope.size += 1;
}

function prescan(node, scope, loop) {
  if (FUNCTIONS.has(node.type)) {
    if (node.type === "FunctionDeclaration") unsupported("function declaration");
    return;
  }
  const inner = loop + (LOOPS.has(node.type) ? 1 : 0);
  if (node.type === "VariableDeclaration") {
    for (const declarator of node.declarations) {
      if (declarator.id.type !== "Identifier") unsupported("destructuring");
      declare(scope, declarator.id.name, node.kind, inner > 0);
    }
  } else if (node.type === "CatchClause" && node.param) {
    if (node.param.type !== "Identifier") unsupported("destructuring");
    declare(scope, node.param.name, "catch", inner > 0);
  }
  for (const child of children(node)) prescan(child, scope, inner);
}

export class Program {
  constructor() {
    this.units = [];
    this.consts = [];
    this.constIndex = new Map();
    this.free = new Map();
  }

  constant(value) {
    const key = `${typeof value}:${Object.is(value, -0) ? "-0" : String(value)}`;
    if (!this.constIndex.has(key)) this.constIndex.set(key, this.consts.push(value) - 1);
    return this.constIndex.get(key);
  }

  freeSlot(name) {
    if (!this.free.has(name)) this.free.set(name, this.free.size);
    return this.free.get(name);
  }

  compile(fn) {
    this.free = new Map();
    return this.fn(fn, null);
  }

  fn(node, parent) {
    if (node.async || node.generator) unsupported("async or generator");
    if (node.params.some((param) => param.type !== "Identifier")) unsupported("parameter pattern");
    const scope = { names: new Map(), parent, size: 0, temps: 0 };
    for (const param of node.params) declare(scope, param.name, "param", false);
    const unit = { code: [], n: 0, a: node.params.length, w: node.type === "ArrowFunctionExpression" ? 1 : 0 };
    const index = this.units.push(unit) - 1;
    const body = node.body.type === "BlockStatement" ? node.body.body : [{ type: "ReturnStatement", argument: node.body }];
    for (const statement of body) prescan(statement, scope, 0);
    new Emitter(this, scope, unit).run(body);
    unit.n = scope.size + scope.temps;
    return index;
  }
}

class Emitter {
  constructor(program, scope, unit) {
    this.program = program;
    this.scope = scope;
    this.code = unit.code;
    this.unit = unit;
    this.loops = [];
    this.chains = [];
    this.tries = 0;
  }

  run(body) {
    for (const statement of body) this.statement(statement);
    this.op("UNDEF");
    this.op("RET");
  }

  op(name, ...args) {
    this.code.push(OPS.indexOf(name), ...args);
  }

  jump(name) {
    this.op(name, -1);
    return this.code.length - 1;
  }

  patch(at) {
    this.code[at] = this.code.length;
  }

  constant(value) {
    this.op("CONST", this.program.constant(value));
  }

  lookup(name) {
    let depth = 0;
    for (let scope = this.scope; scope; scope = scope.parent, depth += 1) {
      const binding = scope.names.get(name);
      if (!binding) continue;
      if (depth > 0 && binding.inLoop && binding.kind !== "var" && binding.kind !== "param") unsupported(`captured loop binding ${name}`);
      return { depth, index: binding.index };
    }
    return null;
  }

  temp() {
    const index = this.scope.size + this.scope.temps;
    this.scope.temps += 1;
    return index;
  }

  statement(node) {
    switch (node.type) {
      case "ExpressionStatement":
        this.expression(node.expression);
        this.op("POP");
        return;
      case "VariableDeclaration":
        for (const declarator of node.declarations) {
          if (!declarator.init && node.kind === "var") continue;
          if (declarator.init) this.expression(declarator.init);
          else this.op("UNDEF");
          const slot = this.lookup(declarator.id.name);
          this.op("STORE", slot.depth, slot.index);
          this.op("POP");
        }
        return;
      case "ReturnStatement":
        if (node.argument) this.expression(node.argument);
        else this.op("UNDEF");
        this.op("RET");
        return;
      case "IfStatement": {
        this.expression(node.test);
        const toElse = this.jump("JF");
        this.statement(node.consequent);
        if (node.alternate) {
          const toEnd = this.jump("JMP");
          this.patch(toElse);
          this.statement(node.alternate);
          this.patch(toEnd);
        } else {
          this.patch(toElse);
        }
        return;
      }
      case "BlockStatement":
        for (const statement of node.body) this.statement(statement);
        return;
      case "ForStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        this.loop(node);
        return;
      case "BreakStatement":
      case "ContinueStatement": {
        const loop = this.loops[this.loops.length - 1];
        if (node.label || !loop || loop.tries !== this.tries) unsupported(`${node.type} here`);
        (node.type === "BreakStatement" ? loop.breaks : loop.continues).push(this.jump("JMP"));
        return;
      }
      case "ThrowStatement":
        this.expression(node.argument);
        this.op("THROW");
        return;
      case "TryStatement": {
        if (node.finalizer || !node.handler) unsupported("try without catch or with finally");
        const handlerAt = this.jump("TRY");
        this.tries += 1;
        this.statement(node.block);
        this.tries -= 1;
        this.op("ENDTRY");
        const toEnd = this.jump("JMP");
        this.patch(handlerAt);
        if (node.handler.param) {
          const slot = this.lookup(node.handler.param.name);
          this.op("STORE", slot.depth, slot.index);
        }
        this.op("POP");
        this.statement(node.handler.body);
        this.patch(toEnd);
        return;
      }
      case "EmptyStatement":
        return;
      default:
        unsupported(node.type);
    }
  }

  loop(node) {
    const context = { breaks: [], continues: [], tries: this.tries };
    this.loops.push(context);
    if (node.type === "ForStatement" && node.init) {
      if (node.init.type === "VariableDeclaration") this.statement(node.init);
      else this.statement({ type: "ExpressionStatement", expression: node.init });
    }
    const start = this.code.length;
    let exit = null;
    if (node.type !== "DoWhileStatement") {
      if (node.test) {
        this.expression(node.test);
        exit = this.jump("JF");
      }
      this.statement(node.body);
      for (const at of context.continues) this.patch(at);
      if (node.update) {
        this.expression(node.update);
        this.op("POP");
      }
      this.op("JMP", start);
    } else {
      this.statement(node.body);
      for (const at of context.continues) this.patch(at);
      this.expression(node.test);
      this.op("JT", start);
    }
    if (exit !== null) this.patch(exit);
    for (const at of context.breaks) this.patch(at);
    this.loops.pop();
  }

  key(node) {
    if (node.object.type === "Super" || node.property.type === "PrivateIdentifier") unsupported("super or private member");
    this.expression(node.object);
    if (node.optional) this.chains[this.chains.length - 1].push(this.jump("OPT"));
    if (node.computed) this.expression(node.property);
    else this.constant(node.property.name);
  }

  expression(node) {
    switch (node.type) {
      case "Literal":
        if (node.regex) this.op("REGEX", this.program.constant(node.regex.pattern), this.program.constant(node.regex.flags));
        else if (node.bigint) unsupported("bigint");
        else if (node.value === null) this.constant(null);
        else this.constant(node.value);
        return;
      case "Identifier":
        this.identifier(node.name);
        return;
      case "ThisExpression":
        this.op("THIS");
        return;
      case "ArrayExpression":
        if (node.elements.some((element) => !element || element.type === "SpreadElement")) unsupported("array hole or spread");
        for (const element of node.elements) this.expression(element);
        this.op("ARR", node.elements.length);
        return;
      case "ObjectExpression":
        for (const property of node.properties) {
          if (property.type !== "Property" || property.kind !== "init") unsupported("object member");
          if (property.computed) this.expression(property.key);
          else this.constant(property.key.type === "Identifier" ? property.key.name : property.key.value);
          this.expression(property.value);
        }
        this.op("OBJ", node.properties.length);
        return;
      case "TemplateLiteral":
        if (node.quasis.some((quasi) => quasi.value.cooked === null)) unsupported("template escape");
        this.constant(node.quasis[0].value.cooked);
        node.expressions.forEach((expression, index) => {
          this.expression(expression);
          this.op("TOSTR");
          this.op("BIN", BINARY.indexOf("+"));
          this.constant(node.quasis[index + 1].value.cooked);
          this.op("BIN", BINARY.indexOf("+"));
        });
        return;
      case "UnaryExpression":
        this.unary(node);
        return;
      case "UpdateExpression":
        this.update(node);
        return;
      case "BinaryExpression":
        if (!BINARY.includes(node.operator) || node.left.type === "PrivateIdentifier") unsupported(`operator ${node.operator}`);
        this.expression(node.left);
        this.expression(node.right);
        this.op("BIN", BINARY.indexOf(node.operator));
        return;
      case "LogicalExpression": {
        this.expression(node.left);
        const toEnd = this.jump({ "&&": "JFK", "||": "JTK", "??": "JNK" }[node.operator]);
        this.expression(node.right);
        this.patch(toEnd);
        return;
      }
      case "AssignmentExpression":
        this.assignment(node);
        return;
      case "ConditionalExpression": {
        this.expression(node.test);
        const toElse = this.jump("JF");
        this.expression(node.consequent);
        const toEnd = this.jump("JMP");
        this.patch(toElse);
        this.expression(node.alternate);
        this.patch(toEnd);
        return;
      }
      case "CallExpression":
        this.call(node);
        return;
      case "NewExpression":
        if (node.arguments.some((argument) => argument.type === "SpreadElement")) unsupported("spread");
        this.expression(node.callee);
        for (const argument of node.arguments) this.expression(argument);
        this.op("NEW", node.arguments.length);
        return;
      case "MemberExpression":
        this.key(node);
        this.op("GET");
        return;
      case "ChainExpression": {
        const ends = [];
        this.chains.push(ends);
        this.expression(node.expression);
        this.chains.pop();
        for (const at of ends) this.patch(at);
        return;
      }
      case "SequenceExpression":
        node.expressions.forEach((expression, index) => {
          this.expression(expression);
          if (index < node.expressions.length - 1) this.op("POP");
        });
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.op("FUNC", this.program.fn(node, this.scope));
        return;
      default:
        unsupported(node.type);
    }
  }

  identifier(name) {
    const slot = this.lookup(name);
    if (slot) this.op("LOAD", slot.depth, slot.index);
    else if (name === "undefined") this.op("UNDEF");
    else if (name === "arguments") unsupported("arguments");
    else this.op("FREE", this.program.freeSlot(name));
  }

  unary(node) {
    const argument = node.argument;
    if (node.operator === "delete") {
      if (argument.type !== "MemberExpression") unsupported("delete target");
      this.key(argument);
      this.op("DEL");
      return;
    }
    if (node.operator === "typeof" && argument.type === "Identifier" && !this.lookup(argument.name)) {
      this.op("TYPEOF_FREE", this.program.freeSlot(argument.name));
      return;
    }
    if (!UNARY.includes(node.operator)) unsupported(`operator ${node.operator}`);
    this.expression(argument);
    this.op("UN", UNARY.indexOf(node.operator));
  }

  store(target) {
    const slot = this.lookup(target.name);
    if (!slot) unsupported(`write to outer variable ${target.name}`);
    this.op("STORE", slot.depth, slot.index);
  }

  assignment(node) {
    const operator = node.operator.slice(0, -1);
    if (node.operator !== "=" && !BINARY.includes(operator)) unsupported(`operator ${node.operator}`);
    if (node.left.type === "Identifier") {
      if (node.operator !== "=") this.identifier(node.left.name);
      this.expression(node.right);
      if (node.operator !== "=") this.op("BIN", BINARY.indexOf(operator));
      this.store(node.left);
      return;
    }
    if (node.left.type !== "MemberExpression" || node.left.optional) unsupported("assignment target");
    this.key(node.left);
    if (node.operator !== "=") {
      this.op("DUP2");
      this.op("GET");
    }
    this.expression(node.right);
    if (node.operator !== "=") this.op("BIN", BINARY.indexOf(operator));
    this.op("SET");
  }

  update(node) {
    const step = BINARY.indexOf(node.operator === "++" ? "+" : "-");
    const target = node.argument;
    if (target.type === "Identifier") {
      this.identifier(target.name);
      this.op("TONUM");
      if (node.prefix) {
        this.constant(1);
        this.op("BIN", step);
        this.store(target);
      } else {
        this.op("DUP");
        this.constant(1);
        this.op("BIN", step);
        this.store(target);
        this.op("POP");
      }
      return;
    }
    if (target.type !== "MemberExpression" || target.optional) unsupported("update target");
    this.key(target);
    this.op("DUP2");
    this.op("GET");
    this.op("TONUM");
    const temp = this.temp();
    if (!node.prefix) this.op("STORE", 0, temp);
    this.constant(1);
    this.op("BIN", step);
    this.op("SET");
    if (!node.prefix) {
      this.op("POP");
      this.op("LOAD", 0, temp);
    }
  }

  call(node) {
    if (node.arguments.some((argument) => argument.type === "SpreadElement")) unsupported("spread");
    const callee = node.callee;
    if (callee.type === "MemberExpression") {
      if (callee.object.type === "Super" || callee.property.type === "PrivateIdentifier") unsupported("super or private member");
      this.expression(callee.object);
      if (callee.optional) this.chains[this.chains.length - 1].push(this.jump("OPT"));
      this.op("DUP");
      if (callee.computed) this.expression(callee.property);
      else this.constant(callee.property.name);
      this.op("GET");
    } else {
      this.op("UNDEF");
      this.expression(callee);
    }
    if (node.optional) this.chains[this.chains.length - 1].push(this.jump("OPTC"));
    for (const argument of node.arguments) this.expression(argument);
    this.op("CALL", node.arguments.length);
  }
}
