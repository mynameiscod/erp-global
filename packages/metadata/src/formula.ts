/**
 * A small, safe formula language for calculated fields.
 *
 *   qty * rate
 *   IF(age >= 18, "Adult", "Minor")
 *   CONCAT(first_name, " ", last_name)
 *   DAYS_BETWEEN(admission_date, TODAY())
 *
 * It is parsed into a tree and interpreted: no JavaScript is ever evaluated,
 * there are no loops, and only the functions below exist. Field names refer to
 * the same record's fields.
 *
 * Conditions in rules, workflows and automations can also use the context:
 *
 *   old.amount            value before this save
 *   user.id               the acting user
 *   CHANGED(amount)       the field changed in this save
 *   HAS_ROLE("Finance")   the acting user holds this role (name or key)
 *   IN_UNIT("HYD")        the record is in the unit with this code, or below it
 *   STATUS()              the record's workflow state
 */

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'field'; name: string }
  | { kind: 'unary'; op: '-' | '!'; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

type Token = { t: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string; pos: number };

const MAX_LENGTH = 2000;
const MAX_DEPTH = 50;

function tokenize(src: string): Token[] {
  if (src.length > MAX_LENGTH)
    throw new FormulaError(`Formula is longer than ${MAX_LENGTH} characters`);
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError('Invalid number', i);
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError('Unclosed text', i);
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||', '<>'].includes(two)) {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%()<>,!&='.includes(c)) {
      // `=` and `&` are accepted as spreadsheet-style equality and concatenation.
      out.push({ t: 'op', v: c === '=' ? '==' : c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`, i);
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

/** Dotted names that read the context instead of the record. */
const CONTEXT_PREFIXES = ['old.', 'user.'];
/** Functions that read the context; not allowed in calculated fields. */
export const CONTEXT_FUNCTIONS = ['CHANGED', 'HAS_ROLE', 'IN_UNIT', 'STATUS'];

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '&': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.i];
  }
  private next(): Token {
    return this.tokens[this.i++];
  }
  private expect(v: string): void {
    const t = this.next();
    if (t.v !== v) throw new FormulaError(`Expected "${v}"`, t.pos);
  }

  parse(): Node {
    const node = this.expr(0, 0);
    const t = this.peek();
    if (t.t !== 'eof') throw new FormulaError(`Unexpected "${t.v}"`, t.pos);
    return node;
  }

  private expr(minPrec: number, depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply');
    let left = this.unary(depth);
    for (;;) {
      const t = this.peek();
      const prec = t.t === 'op' ? PRECEDENCE[t.v] : undefined;
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.expr(prec + 1, depth + 1);
      left = { kind: 'binary', op: t.v, left, right };
    }
    return left;
  }

  private unary(depth: number): Node {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) {
      this.next();
      return { kind: 'unary', op: t.v, arg: this.unary(depth + 1) };
    }
    return this.primary(depth);
  }

  private primary(depth: number): Node {
    const t = this.next();
    if (t.t === 'num') return { kind: 'num', value: Number(t.v) };
    if (t.t === 'str') return { kind: 'str', value: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr(0, depth + 1);
      this.expect(')');
      return e;
    }
    if (t.t === 'id') {
      const upper = t.v.toUpperCase();
      if (upper === 'TRUE') return { kind: 'bool', value: true };
      if (upper === 'FALSE') return { kind: 'bool', value: false };
      if (upper === 'NULL') return { kind: 'null' };
      if (this.peek().v === '(') {
        this.next();
        const args: Node[] = [];
        if (this.peek().v !== ')') {
          do args.push(this.expr(0, depth + 1));
          while (this.peek().v === ',' && this.next());
        }
        this.expect(')');
        if (!(upper in FUNCTIONS)) throw new FormulaError(`Unknown function ${t.v}`, t.pos);
        if (upper === 'CHANGED' && (args.length !== 1 || args[0].kind !== 'field')) {
          throw new FormulaError('CHANGED needs a field name, e.g. CHANGED(amount)', t.pos);
        }
        const [min, max] = FUNCTIONS[upper].arity;
        if (args.length < min || args.length > max) {
          throw new FormulaError(
            `${upper} takes ${min === max ? min : `${min} to ${max}`} arguments`,
            t.pos,
          );
        }
        return { kind: 'call', name: upper, args };
      }
      if (t.v.includes('.') && !CONTEXT_PREFIXES.some((p) => t.v.startsWith(p))) {
        throw new FormulaError(`Unknown name "${t.v}"`, t.pos);
      }
      return { kind: 'field', name: t.v };
    }
    throw new FormulaError(
      t.t === 'eof' ? 'Formula ends unexpectedly' : `Unexpected "${t.v}"`,
      t.pos,
    );
  }
}

type Value = number | string | boolean | null;

const num = (v: Value): number => {
  if (v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(v);
  if (Number.isNaN(n)) throw new FormulaError(`"${v}" is not a number`);
  return n;
};
const str = (v: Value): string => (v === null ? '' : String(v));
const truthy = (v: Value): boolean => v !== null && v !== false && v !== 0 && v !== '';
const toDate = (v: Value): Date => {
  const d = new Date(str(v));
  if (Number.isNaN(d.getTime())) throw new FormulaError(`"${v}" is not a date`);
  return d;
};
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

interface Fn {
  arity: [number, number];
  /** Receives lazily evaluated arguments so IF only evaluates the branch it needs. */
  call: (args: (() => Value)[], ctx: EvalContext) => Value;
}

const FUNCTIONS: Record<string, Fn> = {
  IF: { arity: [2, 3], call: ([c, a, b]) => (truthy(c()) ? a() : b ? b() : null) },
  AND: { arity: [1, 20], call: (args) => args.every((a) => truthy(a())) },
  OR: { arity: [1, 20], call: (args) => args.some((a) => truthy(a())) },
  NOT: { arity: [1, 1], call: ([a]) => !truthy(a()) },
  COALESCE: {
    arity: [1, 20],
    call: (args) => {
      for (const a of args) {
        const v = a();
        if (v !== null && v !== '') return v;
      }
      return null;
    },
  },
  ROUND: {
    arity: [1, 2],
    call: ([a, d]) => {
      const f = 10 ** (d ? num(d()) : 0);
      return Math.round(num(a()) * f) / f;
    },
  },
  FLOOR: { arity: [1, 1], call: ([a]) => Math.floor(num(a())) },
  CEIL: { arity: [1, 1], call: ([a]) => Math.ceil(num(a())) },
  ABS: { arity: [1, 1], call: ([a]) => Math.abs(num(a())) },
  MIN: { arity: [1, 20], call: (args) => Math.min(...args.map((a) => num(a()))) },
  MAX: { arity: [1, 20], call: (args) => Math.max(...args.map((a) => num(a()))) },
  SUM: { arity: [1, 20], call: (args) => args.reduce((s, a) => s + num(a()), 0) },
  CONCAT: { arity: [1, 20], call: (args) => args.map((a) => str(a())).join('') },
  UPPER: { arity: [1, 1], call: ([a]) => str(a()).toUpperCase() },
  LOWER: { arity: [1, 1], call: ([a]) => str(a()).toLowerCase() },
  TRIM: { arity: [1, 1], call: ([a]) => str(a()).trim() },
  LEN: { arity: [1, 1], call: ([a]) => str(a()).length },
  LEFT: { arity: [2, 2], call: ([a, n]) => str(a()).slice(0, num(n())) },
  RIGHT: { arity: [2, 2], call: ([a, n]) => str(a()).slice(-num(n())) },
  TODAY: { arity: [0, 0], call: (_a, ctx) => isoDate(ctx.now) },
  YEAR: { arity: [1, 1], call: ([a]) => toDate(a()).getUTCFullYear() },
  MONTH: { arity: [1, 1], call: ([a]) => toDate(a()).getUTCMonth() + 1 },
  DAY: { arity: [1, 1], call: ([a]) => toDate(a()).getUTCDate() },
  DAYS_BETWEEN: {
    arity: [2, 2],
    call: ([a, b]) => Math.round((toDate(b()).getTime() - toDate(a()).getTime()) / 86_400_000),
  },
  ADD_DAYS: {
    arity: [2, 2],
    call: ([a, n]) => isoDate(new Date(toDate(a()).getTime() + num(n()) * 86_400_000)),
  },
  IS_EMPTY: { arity: [1, 1], call: ([a]) => str(a()).trim() === '' },
  CONTAINS: {
    arity: [2, 2],
    call: ([a, b]) => str(a()).toLowerCase().includes(str(b()).toLowerCase()),
  },
  // Evaluated specially (it needs the field name, not its value); see `evaluate`.
  CHANGED: { arity: [1, 1], call: () => false },
  HAS_ROLE: {
    arity: [1, 1],
    call: ([a], ctx) => {
      const want = str(a()).trim().toLowerCase();
      return (ctx.user?.roles ?? []).some((r) => r.toLowerCase() === want);
    },
  },
  IN_UNIT: {
    arity: [1, 1],
    call: ([a], ctx) => {
      const want = str(a()).trim().toLowerCase();
      return (ctx.unitCodes ?? []).some((c) => c.toLowerCase() === want);
    },
  },
  STATUS: { arity: [0, 0], call: (_a, ctx) => ctx.status ?? null },
};

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

export interface EvalContext {
  fields: Record<string, unknown>;
  now: Date;
  /** Values before this save (missing on create). */
  old?: Record<string, unknown>;
  /** The acting user: id and role names/keys. */
  user?: { id: string; roles: string[] };
  /** Codes of the record's org unit and every unit above it. */
  unitCodes?: string[];
  /** Current workflow state of the record. */
  status?: string | null;
}

function toValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'amount' in (v as object))
    return num((v as { amount: Value }).amount);
  if (Array.isArray(v)) return v.map(String).join(',');
  return str(String(v));
}

function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'field': {
      if (node.name.startsWith('old.')) return toValue(ctx.old?.[node.name.slice(4)]);
      if (node.name.startsWith('user.')) {
        return node.name === 'user.id' ? (ctx.user?.id ?? null) : null;
      }
      return toValue(ctx.fields[node.name]);
    }
    case 'unary': {
      const a = evaluate(node.arg, ctx);
      return node.op === '-' ? -num(a) : !truthy(a);
    }
    case 'binary': {
      if (node.op === '&&')
        return truthy(evaluate(node.left, ctx)) && truthy(evaluate(node.right, ctx));
      if (node.op === '||')
        return truthy(evaluate(node.left, ctx)) || truthy(evaluate(node.right, ctx));
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      switch (node.op) {
        case '+':
          return num(l) + num(r);
        case '-':
          return num(l) - num(r);
        case '*':
          return num(l) * num(r);
        case '/':
          if (num(r) === 0) return null;
          return num(l) / num(r);
        case '%':
          if (num(r) === 0) return null;
          return num(l) % num(r);
        case '&':
          return str(l) + str(r);
        case '==':
          return l === r || (typeof l !== typeof r && str(l) === str(r));
        case '!=':
          return !(l === r || (typeof l !== typeof r && str(l) === str(r)));
        case '<':
          return typeof l === 'string' && typeof r === 'string' ? l < r : num(l) < num(r);
        case '<=':
          return typeof l === 'string' && typeof r === 'string' ? l <= r : num(l) <= num(r);
        case '>':
          return typeof l === 'string' && typeof r === 'string' ? l > r : num(l) > num(r);
        case '>=':
          return typeof l === 'string' && typeof r === 'string' ? l >= r : num(l) >= num(r);
      }
      throw new FormulaError(`Unknown operator ${node.op}`);
    }
    case 'call':
      if (node.name === 'CHANGED') {
        const name = (node.args[0] as { name: string }).name;
        const now = JSON.stringify(ctx.fields[name] ?? null);
        if (!ctx.old) return now !== 'null' && now !== '""';
        return now !== JSON.stringify(ctx.old[name] ?? null);
      }
      return FUNCTIONS[node.name].call(
        node.args.map((a) => () => evaluate(a, ctx)),
        ctx,
      );
  }
}

function collectFields(node: Node, out: Set<string>, context: Set<string>): void {
  switch (node.kind) {
    case 'field':
      if (node.name.includes('.')) {
        context.add(node.name);
        if (node.name.startsWith('old.')) out.add(node.name.slice(4));
      } else out.add(node.name);
      break;
    case 'unary':
      collectFields(node.arg, out, context);
      break;
    case 'binary':
      collectFields(node.left, out, context);
      collectFields(node.right, out, context);
      break;
    case 'call':
      if (CONTEXT_FUNCTIONS.includes(node.name)) context.add(`${node.name}()`);
      node.args.forEach((a) => collectFields(a, out, context));
      break;
  }
}

export interface CompiledFormula {
  /** Field keys the formula reads (including those read through `old.`). */
  fields: string[];
  /** Context the formula reads: `old.x`, `user.id`, `CHANGED()`… Empty for plain formulas. */
  context: string[];
  evaluate(ctx: EvalContext): Value;
}

export function compileFormula(source: string): CompiledFormula {
  const tree = new Parser(tokenize(source)).parse();
  const fields = new Set<string>();
  const context = new Set<string>();
  collectFields(tree, fields, context);
  return {
    fields: [...fields],
    context: [...context],
    evaluate: (ctx) => {
      const v = evaluate(tree, ctx);
      return typeof v === 'number' && !Number.isFinite(v) ? null : v;
    },
  };
}
