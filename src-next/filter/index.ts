/**
 * Composable log filter — parser, AST, and evaluator.
 *
 * Syntax:
 *   field:value         — match a specific field
 *   plain text          — matches raw, tag, or message (case-insensitive)
 *   "quoted text"       — multi-word text match
 *   expr1 expr2         — implicit AND (juxtaposition)
 *   expr1 & expr2       — explicit AND
 *   expr1 | expr2       — OR (lower precedence than AND)
 *   !expr               — NOT
 *   (expr)              — grouping
 *
 * Supported fields:
 *   package:com.example  — resolved to PID(s) via adb shell pidof
 *   tag:MyTag            — logcat tag (substring, case-insensitive)
 *   message:text         — message field (substring, case-insensitive)
 *   raw:text             — full raw line (substring, case-insensitive)
 *   level:E              — level (V/D/I/W/E/F or full name)
 *   pid:1234             — exact PID match
 */

import type { ViewLine, LogLevel } from '../bridge/types';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type FilterNode =
  | { kind: 'and'; children: FilterNode[] }
  | { kind: 'or'; children: FilterNode[] }
  | { kind: 'not'; child: FilterNode }
  | { kind: 'field'; field: string; value: string }
  | { kind: 'text'; value: string };

export class FilterParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FilterParseError';
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'or' }
  | { t: 'and' }
  | { t: 'not' }
  | { t: 'field'; field: string; value: string }
  | { t: 'text'; value: string };

function readQuoted(input: string, start: number): [string, number] {
  let i = start;
  let val = '';
  while (i < input.length && input[i] !== '"') {
    if (input[i] === '\\' && i + 1 < input.length) {
      val += input[i + 1];
      i += 2;
    } else {
      val += input[i];
      i++;
    }
  }
  if (i < input.length) i++; // consume closing "
  return [val, i];
}

function tokenize(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }

    // Single-char operators
    if (input[i] === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (input[i] === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (input[i] === '|') { tokens.push({ t: 'or' }); i++; continue; }
    if (input[i] === '&') { tokens.push({ t: 'and' }); i++; continue; }
    if (input[i] === '!') { tokens.push({ t: 'not' }); i++; continue; }

    // Quoted string — bare text atom
    if (input[i] === '"') {
      i++;
      const [val, nextI] = readQuoted(input, i);
      i = nextI;
      tokens.push({ t: 'text', value: val });
      continue;
    }

    // Word — possibly field:value
    let word = '';
    while (i < input.length && !/[\s()|&!]/.test(input[i])) {
      word += input[i];
      i++;
    }
    if (!word) continue;

    // Keyword operators (case-insensitive)
    const wordLower = word.toLowerCase();
    if (wordLower === 'and') { tokens.push({ t: 'and' }); continue; }
    if (wordLower === 'or')  { tokens.push({ t: 'or' });  continue; }
    if (wordLower === 'not') { tokens.push({ t: 'not' }); continue; }

    const colonIdx = word.indexOf(':');
    if (colonIdx > 0) {
      const field = word.slice(0, colonIdx);
      let value = word.slice(colonIdx + 1);

      // If value is empty and next char is a quote, consume quoted value
      if (value === '' && i < input.length && input[i] === '"') {
        i++;
        const [val, nextI] = readQuoted(input, i);
        i = nextI;
        value = val;
      }

      tokens.push({ t: 'field', field, value });
    } else {
      tokens.push({ t: 'text', value: word });
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive descent parser
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Tok[]) {}

  done(): boolean { return this.pos >= this.tokens.length; }
  peek(): Tok | undefined { return this.tokens[this.pos]; }
  consume(): Tok { return this.tokens[this.pos++]; }

  // or_expr = and_expr ('|' and_expr)*
  parseOr(): FilterNode {
    const first = this.parseAnd();
    const children = [first];
    while (this.peek()?.t === 'or') {
      this.consume();
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0] : { kind: 'or', children };
  }

  // and_expr = not_expr (('&')? not_expr)*  — implicit AND by juxtaposition
  parseAnd(): FilterNode {
    const first = this.parseNot();
    const children = [first];
    while (this.isAndContinue()) {
      if (this.peek()?.t === 'and') this.consume(); // consume optional explicit &
      children.push(this.parseNot());
    }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  }

  // Returns true if the next token can begin a not_expr (used for implicit AND)
  private isAndContinue(): boolean {
    const tok = this.peek();
    if (!tok) return false;
    // Stop at | and ) — these break the AND sequence
    if (tok.t === 'or' || tok.t === 'rparen') return false;
    return true;
  }

  // not_expr = '!' not_expr | atom
  parseNot(): FilterNode {
    if (this.peek()?.t === 'not') {
      this.consume();
      return { kind: 'not', child: this.parseNot() };
    }
    return this.parseAtom();
  }

  // atom = '(' or_expr ')' | field | text
  parseAtom(): FilterNode {
    const tok = this.peek();
    if (!tok) throw new FilterParseError('Unexpected end of expression');

    if (tok.t === 'lparen') {
      this.consume();
      const inner = this.parseOr();
      if (this.peek()?.t !== 'rparen') throw new FilterParseError('Missing closing )');
      this.consume();
      return inner;
    }

    if (tok.t === 'field') {
      this.consume();
      return { kind: 'field', field: tok.field, value: tok.value };
    }

    if (tok.t === 'text') {
      this.consume();
      return { kind: 'text', value: tok.value };
    }

    throw new FilterParseError(`Unexpected token: ${tok.t}`);
  }
}

// ---------------------------------------------------------------------------
// Public parse API
// ---------------------------------------------------------------------------

/** Parse a filter expression into an AST. Returns null for empty input. */
export function parseFilter(expr: string): FilterNode | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;
  const parser = new Parser(tokens);
  const node = parser.parseOr();
  if (!parser.done()) {
    const tok = parser.peek();
    throw new FilterParseError(`Unexpected token: "${tok?.t ?? '?'}"`);
  }
  return node;
}

/** Walk AST and collect all package: field values (for PID resolution). */
export function extractPackageNames(node: FilterNode): string[] {
  const names: string[] = [];
  function walk(n: FilterNode) {
    if (n.kind === 'field' && n.field === 'package') {
      names.push(n.value);
    } else if (n.kind === 'and' || n.kind === 'or') {
      n.children.forEach(walk);
    } else if (n.kind === 'not') {
      walk(n.child);
    }
  }
  walk(node);
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const LEVEL_MAP: Partial<Record<string, LogLevel>> = {
  V: 'Verbose', VERBOSE: 'Verbose',
  D: 'Debug',   DEBUG: 'Debug',
  I: 'Info',    INFO: 'Info',
  W: 'Warn',    WARN: 'Warn',    WARNING: 'Warn',
  E: 'Error',   ERROR: 'Error',
  F: 'Fatal',   FATAL: 'Fatal',
};

function matchLevel(value: string, level: LogLevel): boolean {
  const normalized = LEVEL_MAP[value.toUpperCase()] ?? null;
  return normalized === level;
}

/** Returns true if the given field atom matches this line. */
function matchField(
  field: string,
  value: string,
  line: ViewLine,
  packagePids: Map<string, number[]>,
): boolean {
  switch (field) {
    case 'package': {
      const pids = packagePids.get(value);
      if (!pids || pids.length === 0) return false;
      return pids.includes(line.pid);
    }
    case 'tag':
      return line.tag.toLowerCase().includes(value.toLowerCase());
    case 'message':
      return line.message.toLowerCase().includes(value.toLowerCase());
    case 'raw':
      return line.raw.toLowerCase().includes(value.toLowerCase());
    case 'level':
      return matchLevel(value, line.level);
    case 'pid': {
      const n = parseInt(value, 10);
      return !isNaN(n) && line.pid === n;
    }
    case 'tid': {
      const n = parseInt(value, 10);
      return !isNaN(n) && line.tid === n;
    }
    default:
      // Unknown field — treat as text search across tag + message
      return (
        line.tag.toLowerCase().includes(field.toLowerCase()) ||
        line.message.toLowerCase().includes(field.toLowerCase())
      );
  }
}

/** Evaluate whether a ViewLine matches the filter AST. */
export function matchesFilter(
  node: FilterNode,
  line: ViewLine,
  packagePids: Map<string, number[]>,
): boolean {
  switch (node.kind) {
    case 'and':
      return node.children.every((c) => matchesFilter(c, line, packagePids));
    case 'or':
      return node.children.some((c) => matchesFilter(c, line, packagePids));
    case 'not':
      return !matchesFilter(node.child, line, packagePids);
    case 'field':
      return matchField(node.field, node.value, line, packagePids);
    case 'text': {
      const val = node.value.toLowerCase();
      return (
        line.raw.toLowerCase().includes(val) ||
        line.tag.toLowerCase().includes(val) ||
        line.message.toLowerCase().includes(val)
      );
    }
  }
}
