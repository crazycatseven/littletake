import type { Scalar } from './schema.ts';

/** Bounded arithmetic only: no JavaScript evaluation, properties, calls or ambient access. */
export function expression(value: Scalar, reference: (name: string) => number): number {
  if (typeof value === 'number') return finite(value);
  const tokens = value.match(/\{[a-zA-Z0-9_.-]+\}|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-zA-Z_][a-zA-Z0-9_.]*|[()+*/-]/gi) ?? [];
  if (tokens.join('') !== value.replace(/\s/g, '') || tokens.length > 128) throw new Error('Invalid expression: ' + value);
  let cursor = 0, depth = 0;
  const atom = (): number => {
    if (++depth > 32) throw new Error('Expression is too deeply nested.');
    const token = tokens[cursor++]; let result: number;
    if (token === '+' || token === '-') result = (token === '-' ? -1 : 1) * atom();
    else if (token === '(') { result = sum(); if (tokens[cursor++] !== ')') throw new Error('Missing closing parenthesis.'); }
    else if (token && /^(?:\d|\.)/.test(token)) result = Number(token);
    else if (token && /^[a-zA-Z_{]/.test(token)) result = reference(token.startsWith('{') ? token.slice(1,-1) : token);
    else throw new Error('Expected a number or reference in: ' + value);
    depth--; return finite(result);
  };
  const product = (): number => { let result = atom(); while (tokens[cursor] === '*' || tokens[cursor] === '/') { const op = tokens[cursor++], rhs = atom(); result = finite(op === '*' ? result * rhs : result / rhs); } return result; };
  const sum = (): number => { let result = product(); while (tokens[cursor] === '+' || tokens[cursor] === '-') { const op = tokens[cursor++], rhs = product(); result = finite(op === '+' ? result + rhs : result - rhs); } return result; };
  const result = sum(); if (cursor !== tokens.length) throw new Error('Unexpected expression token: ' + tokens[cursor]); return result;
}
function finite(value: number): number { if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw new Error('Expression must produce a finite value within ±1,000,000.'); return value; }
