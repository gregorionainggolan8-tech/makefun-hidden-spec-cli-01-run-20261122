// mend: one patch tool for every AI edit format. SPEC.md is the contract.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON text-editor tool calls), finds each edit's lines at the first of
// three matching tiers (section 5), and writes every change or none.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Shared build context: strict matching, and the moves made so far (for `R` rows). */
interface Ctx {
  strict: boolean;
  moves: { old: string; new: string }[];
}

/** A file split into lines, with its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function serializeFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.finalBr ? fs.br : '');
}

const leadingWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

/** Line comparison at a tier: 0 exact, 1 trailing spaces/tabs ignored, 2 both ends ignored. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => norm(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(lines[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const want = norm(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

/**
 * Build the replacement lines for an occurrence at `pos`: a context line is
 * written as the file's own matched line; at tier 2 every other line is
 * re-indented from O's first line's leading whitespace to the file's.
 * `ctxO` holds the indices into O that are context lines, in order;
 * `ctxN[j]` says whether N[j] is a context line.
 */
function buildNew(fileLines: string[], pos: number, O: string[], N: string[], ctxO: number[], ctxN: boolean[], tier: number): string[] {
  const out: string[] = [];
  let k = 0;
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos] ?? '');
    P = leadingWs(O[0]!);
  }
  for (let j = 0; j < N.length; j++) {
    if (ctxN[j]) {
      out.push(fileLines[pos + ctxO[k]!]!);
      k += 1;
    } else {
      const line = N[j]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(F + line.slice(P.length));
      else out.push(line);
    }
  }
  return out;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}
interface Hunk {
  A: number;
  items: BodyItem[];
}
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  createFlag: boolean;
  deleteFlag: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined,
    diffOld: undefined, diffNew: undefined, createFlag: false, deleteFlag: false,
    hasPair: false, hunks: [],
  };
}

/** Path from a `--- `/`+++ ` header line: text after 4 chars, up to first tab, trimmed. */
function headerPath(line: string): string | null {
  const s = line.slice(4).split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  return s.startsWith('a/') || s.startsWith('b/') ? s.slice(2) : s;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's body: lines after the header starting with space, `-`, `+`, `\`, or empty. */
function collectBody(lines: string[], j: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', raw: l });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'bs', text: l.slice(1), raw: l });
      j++;
      continue;
    }
    break;
  }
  while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.raw === '') items.pop();
  return { items, next: j };
}

/** O/N of a hunk, with context-line correspondence (SPEC.md section 5). */
function hunkON(h: Hunk): { O: string[]; N: string[]; ctxO: number[]; ctxN: boolean[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctxO: number[] = [];
  const ctxN: boolean[] = [];
  for (const it of h.items) {
    if (it.kind === 'ctx') {
      ctxO.push(O.length);
      O.push(it.text);
      N.push(it.text);
      ctxN.push(true);
    } else if (it.kind === 'old') O.push(it.text);
    else if (it.kind === 'new') {
      N.push(it.text);
      ctxN.push(false);
    }
  }
  return { O, N, ctxO, ctxN };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNL(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.items.length; k++) {
    if (h.items[k]!.kind === 'ctx' || h.items[k]!.kind === 'new') last = k;
  }
  return last >= 0 && last + 1 < h.items.length && h.items[last + 1]!.kind === 'bs';
}

/** Apply a section's hunks in order to a file's lines; throws Fail('no-match'). */
function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = [...fs.lines];
  let finalBr = fs.finalBr;
  let d = 0;
  for (const h of hunks) {
    const { O, N, ctxO, ctxN } = hunkON(h);
    if (O.length === 0) {
      const at = Math.min(h.A + d, lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...N);
      if (atEnd) finalBr = !hunkNoNL(h);
      d += N.length;
      continue;
    }
    const found = findTier(lines, O, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + O.length === lines.length;
    const rep = buildNew(lines, best, O, N, ctxO, ctxN, found.tier);
    lines.splice(best, O.length, ...rep);
    if (atEnd) finalBr = !hunkNoNL(h);
    d += N.length - O.length;
  }
  return { lines, br: fs.br, finalBr };
}

function resolvePath(sec: Section, oldSide: boolean): string | null | undefined {
  if (oldSide) return sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  return sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
}

function unifiedEdit(sec: Section, ctx: Ctx): Edit {
  const oldP = resolvePath(sec, true);
  const newP = resolvePath(sec, false);
  let kind: 'create' | 'delete' | 'move' | 'change' | 'noop';
  if ((sec.createFlag || oldP === null) && newP !== null && newP !== undefined) kind = 'create';
  else if ((sec.deleteFlag || newP === null) && oldP !== null && oldP !== undefined) kind = 'delete';
  else if (oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP) kind = 'move';
  else if (oldP !== null && oldP !== undefined) kind = 'change';
  else kind = 'noop';
  return (tree) => {
    for (const p of [oldP, newP]) {
      if (p !== null && p !== undefined && !safe(p)) throw new Fail('unsafe', p);
    }
    if (kind === 'noop') return;
    if (kind === 'create') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusH = -1;
      let lastPlusI = -1;
      sec.hunks.forEach((h, hi) => {
        h.items.forEach((it, ii) => {
          if (it.kind === 'new') {
            plus.push(it.text);
            lastPlusH = hi;
            lastPlusI = ii;
          }
        });
      });
      const noNL =
        lastPlusH >= 0 &&
        lastPlusI + 1 < sec.hunks[lastPlusH]!.items.length &&
        sec.hunks[lastPlusH]!.items[lastPlusI + 1]!.kind === 'bs';
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (kind === 'move') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const res = applyHunks(parseFile(cur), sec.hunks, ctx.strict, op);
      ctx.moves.push({ old: op, new: np });
      tree.now.set(np, serializeFile(res));
      tree.now.set(op, null);
      return;
    }
    const res = applyHunks(parseFile(cur), sec.hunks, ctx.strict, op);
    tree.now.set(op, serializeFile(res));
  };
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = collectBody(lines, i + 1);
      cur.hunks.push({ A: Number(m[1]), items: body.items });
      inHeader = false;
      i = body.next;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && inHeader && !cur.hasPair) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
        } else {
          cur = newSection();
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.pairNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, ctx));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fs = parseFile(cur);
    const found = findTier(fs.lines, oldLines, 0, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildNew(fs.lines, pos, oldLines, newLines, [], newLines.map(() => false), found.tier);
    const out = [...fs.lines];
    out.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeFile({ lines: out, br: fs.br, finalBr: fs.finalBr }));
  };
}

function parseSR(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= after; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), ctx));
    prevPath = path;
    after = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function v4aApply(fs: FileState, chunks: VChunk[], strict: boolean, path: string): FileState {
  let lines = [...fs.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const at = findAnchor(lines, ch.anchor, cursor, strict);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { O, N, ctxO, ctxN } = hunkON({ A: 0, items: ch.items });
    if (O.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      lines.splice(at, 0, ...N);
      cursor = at + N.length;
      continue;
    }
    const found = findTier(lines, O, cursor, strict);
    if (found === null) throw new Fail('no-match', path);
    let pos: number | null = null;
    for (const p of found.occ) {
      if (ch.eof && p + O.length !== lines.length) continue;
      pos = p;
      break;
    }
    if (pos === null) throw new Fail('no-match', path);
    const rep = buildNew(lines, pos, O, N, ctxO, ctxN, found.tier);
    lines.splice(pos, O.length, ...rep);
    cursor = pos + rep.length;
  }
  return { lines, br: fs.br, finalBr: fs.finalBr };
}

function parseV4A(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.map((l, i) => (blank(l) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  // Section boundaries: header line indices between first+1 and last-1.
  const starts: number[] = [];
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) starts.push(i);
  }
  for (let s = 0; s < starts.length; s++) {
    const h = starts[s]!;
    const head = lines[h]!;
    let end = s + 1 < starts.length ? starts[s + 1]! : last;
    while (end > h + 1 && blank(lines[end - 1]!)) end--;
    if (head.startsWith('*** Add File: ')) {
      const path = head.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let i = h + 1; i < end; i++) {
        const l = lines[i]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (head.startsWith('*** Delete File: ')) {
      const path = head.slice('*** Delete File: '.length).trim();
      for (let i = h + 1; i < end; i++) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    const path = head.slice('*** Update File: '.length).trim();
    let idx = h + 1;
    while (idx < end && blank(lines[idx]!)) idx++;
    let moveTo: string | null = null;
    if (idx < end && lines[idx]!.startsWith('*** Move to: ')) {
      moveTo = lines[idx]!.slice('*** Move to: '.length).trim();
      idx++;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    while (idx < end) {
      const l = lines[idx]!;
      if (blank(l)) {
        if (cur !== null) cur.items.push({ kind: 'ctx', text: '', raw: l });
        idx++;
        continue;
      }
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        chunks.push(cur);
        idx++;
        continue;
      }
      if (l === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
        cur.eof = true;
        cur = null;
        idx++;
        continue;
      }
      if (l.startsWith(' ')) {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
          cur = { anchor: null, eof: false, items: [] };
          chunks.push(cur);
        }
        cur.items.push({ kind: 'ctx', text: l.slice(1), raw: l });
        idx++;
        continue;
      }
      if (l.startsWith('-') || l.startsWith('+')) {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
          cur = { anchor: null, eof: false, items: [] };
          chunks.push(cur);
        }
        cur.items.push({ kind: l.startsWith('-') ? 'old' : 'new', text: l.slice(1), raw: l });
        idx++;
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${h + 1}`);
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const curText = tree.get(path);
      if (curText === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const res = v4aApply(parseFile(curText), chunks, ctx.strict, path);
      if (moveTo !== null) {
        ctx.moves.push({ old: path, new: moveTo });
        tree.now.set(moveTo, serializeFile(res));
        tree.now.set(path, null);
      } else {
        tree.now.set(path, serializeFile(res));
      }
    });
  }
  return edits;
}

// ---- Format detection (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSR(lines, ctx);
    else edits = parseV4A(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with moves reported as one `R old -> new` row sorted by the new path.
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push({ p, was, now });
  }
  const next = new Map<string, string>();
  for (const m of ctx.moves) next.set(m.old, m.new);
  const targets = new Set(next.values());
  const consumed = new Set<string>();
  const claimedEnds = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [from, to] of next) {
    if (targets.has(from)) continue;
    let end = to;
    const seen = new Set([from]);
    while (next.has(end) && !seen.has(end)) {
      seen.add(end);
      end = next.get(end)!;
    }
    if (claimedEnds.has(end)) continue;
    const wasFrom = tree.now.has(from) ? tree.now.get(from)! : tree.original(from);
    const wasTo = tree.now.has(end) ? tree.now.get(end)! : tree.original(end);
    if (tree.original(from) !== null && wasFrom === null && tree.original(end) === null && wasTo !== null) {
      rows.push({ key: end, text: `R ${from} -> ${end}` });
      claimedEnds.add(end);
      consumed.add(from);
      consumed.add(end);
    }
  }
  for (const c of changed) {
    if (consumed.has(c.p)) continue;
    rows.push({ key: c.p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
