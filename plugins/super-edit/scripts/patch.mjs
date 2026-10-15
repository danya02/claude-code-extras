// Patch application, kept free of MCP and filesystem concerns so it can be
// tested directly. `apply` takes the current text of every file and returns the
// new text plus a per-patch outcome; the caller decides what to write.

export const DEFAULT_CONTEXT = 3;

// A patch names a file and either a literal `find` or a `regex`, never both.
// `expect` is the number of matches the caller believes are there. It defaults
// to 1 for a literal and is REQUIRED for a regex: a regex whose match count the
// caller has not predicted is the case where a wrong pattern silently rewrites
// the file, which is the whole failure mode this tool exists to prevent.
export function validate(patch, index) {
  // One-based, to match how the report numbers patches and how the caller
  // counts them when reading its own argument list back.
  const where = `patch #${index + 1}`;
  if (!patch || typeof patch !== "object") return `${where}: not an object`;
  if (typeof patch.file !== "string" || !patch.file) return `${where}: missing "file"`;
  const hasFind = typeof patch.find === "string";
  const hasRegex = typeof patch.regex === "string";
  if (hasFind === hasRegex) return `${where}: give exactly one of "find" or "regex"`;
  if (typeof patch.replace !== "string") return `${where}: missing "replace"`;
  if (patch.expect !== undefined) {
    if (!Number.isInteger(patch.expect) || patch.expect < 1) {
      return `${where}: "expect" must be a positive integer`;
    }
  } else if (hasRegex) {
    return `${where}: "regex" requires "expect" — state how many matches you believe are there, so a wrong pattern fails loudly instead of rewriting the file`;
  }
  if (hasRegex) {
    try {
      new RegExp(patch.regex, "g");
    } catch (err) {
      return `${where}: invalid regex — ${err.message}`;
    }
  }
  if (hasFind && patch.find === "") return `${where}: "find" is empty`;
  return null;
}

function countLiteral(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

// First few match locations as "line N: snippet", so a count mismatch can show
// the caller where the extra or missing matches live without a re-read.
// Multi-line matches collapse to one line; long ones truncate.
export function sampleMatches(text, patch, limit = 3) {
  const out = [];
  const lineAt = (idx) => 1 + (text.slice(0, idx).match(/\n/g) ?? []).length;
  const snippet = (s) => s.replace(/\s+/g, " ").slice(0, 60);
  if (typeof patch.find === "string") {
    for (let i = text.indexOf(patch.find); i !== -1 && out.length < limit; i = text.indexOf(patch.find, i + patch.find.length)) {
      out.push(`line ${lineAt(i)}: ${snippet(patch.find)}`);
    }
    return out;
  }
  const re = new RegExp(patch.regex, patch.flags ? ensureGlobal(patch.flags) : "g");
  let m;
  while (out.length < limit && (m = re.exec(text)) !== null) {
    out.push(`line ${lineAt(m.index)}: ${snippet(m[0])}`);
    if (m.index === re.lastIndex) re.lastIndex += 1; // zero-width match
  }
  return out;
}

// How many times this patch's matcher hits `text`. Split out from `applyOne`
// because the overlap check below has to ask the same question of a second
// buffer: the file as it was before the batch started.
export function countMatches(text, patch) {
  if (typeof patch.find === "string") return countLiteral(text, patch.find);
  const re = new RegExp(patch.regex, patch.flags ? ensureGlobal(patch.flags) : "g");
  return (text.match(re) ?? []).length;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Returns { text, count } or { error }. Applies every match, having already
// confirmed the count is the one the caller predicted.
function applyOne(text, patch) {
  const expect = patch.expect ?? 1;
  const isLiteral = typeof patch.find === "string";
  const found = countMatches(text, patch);

  if (found !== expect) {
    const matches = found > 0 ? sampleMatches(text, patch) : undefined;
    if (isLiteral) {
      return {
        error:
          found === 0
            ? `no match for the literal text (expected ${expect})`
            : `found ${plural(found, "match", "matches")}, expected ${expect}`,
        found,
        matches,
      };
    }
    return {
      error:
        found === 0
          ? `regex matched nothing (expected ${expect})`
          : `regex matched ${plural(found, "time", "times")}, expected ${expect}`,
      found,
      matches,
    };
  }

  if (isLiteral) return { text: text.split(patch.find).join(patch.replace), count: found };
  const re = new RegExp(patch.regex, patch.flags ? ensureGlobal(patch.flags) : "g");
  return { text: text.replace(re, patch.replace), count: found };
}

function ensureGlobal(flags) {
  const clean = flags.replace(/[^gimsuy]/g, "");
  return clean.includes("g") ? clean : `${clean}g`;
}

// A hunk longer than this keeps only its first and last EDGE_LINES, with the
// middle replaced by a marker: a large replacement is text the caller wrote
// moments ago, and field reports measured echoing it back verbatim as the
// single most expensive part of a successful call.
export const MAX_HUNK_LINES = 24;
const EDGE_LINES = 8;

// Changed regions as separate hunks, so the caller can echo them back. The
// harness will not do it for us on a Read-only-tracked file.
//
// This used to report one span from the first to the last differing line,
// which is tight for a single edit — but patches spread across a file merged
// into a span covering everything between them. Field reports measured ~25-30x
// bloat that way, with the untouched middles skipped by every reader, so this
// is now a real line diff. Distant changes produce separate hunks; changes
// within 2*context of each other still merge, like a diff tool's hunks.
export function diffHunks(before, after, rawContext = DEFAULT_CONTEXT) {
  // A negative context made spans run backwards (lastLine < firstLine) and shifted every hunk off its change.
  const context = Number.isInteger(rawContext) ? Math.max(0, rawContext) : DEFAULT_CONTEXT;
  const a = before.split("\n");
  const b = after.split("\n");
  // A file ending in "\n" splits into a phantom empty last element, which was reported as a line that does not
  // exist ("lines 1–6" for a five-line file). Drop it, but only when both sides have it, so that adding or
  // removing the final newline is still a visible change.
  if (before.endsWith("\n") && after.endsWith("\n")) {
    a.pop();
    b.pop();
  }

  // Common prefix and suffix shrink the LCS table to the changed middle —
  // usually a few lines — and bound the fallback when the middle is too big.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  // Disturbed after-side offsets within the middle (0-based). null means the
  // middle is too large to diff: fall back to one span over it, which is the
  // old behaviour and still correct, just blunt.
  let marks;
  if (midA.length * midB.length > 4e6 || midB.length === 0) {
    marks = new Set();
    if (midB.length) for (let j = 0; j < midB.length; j += 1) marks.add(j);
    else if (midA.length) marks.add(0); // deletion only; show around where it was
  } else {
    marks = lcsDisturbed(midA, midB);
  }
  if (!marks.size) return [];

  // Expand each disturbed line by `context` and merge the overlaps.
  const spans = [];
  let start = null;
  let end = null;
  for (const j of [...marks].sort((x, y) => x - y)) {
    const lo = j - context;
    const hi = j + context;
    if (start === null) {
      start = lo;
      end = hi;
    } else if (lo <= end + 1) {
      end = Math.max(end, hi);
    } else {
      spans.push([start, end]);
      start = lo;
      end = hi;
    }
  }
  if (start !== null) spans.push([start, end]);

  const hunks = [];
  for (const [lo, hi] of spans) {
    const to = Math.min(pre + hi, b.length - 1);
    const from = Math.max(0, Math.min(pre + lo, to));
    hunks.push(renderHunk(b, from, to));
  }
  return hunks;
}

// After-side offsets of every changed line: inserted/replaced lines directly,
// and the surviving neighbours of a deletion, since that is where the removal
// is visible. Walks one LCS of the two middles.
function lcsDisturbed(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const disturbed = new Set();
  const mark = (j) => {
    if (j >= 0 && j < m) disturbed.add(j);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      mark(j); // a[i] was deleted in the gap just before b[j]
      i += 1;
    } else {
      mark(j); // b[j] is new
      j += 1;
    }
  }
  for (; j < m; j += 1) mark(j); // trailing insertions
  if (i < n) mark(m - 1); // trailing deletions land at the end of the middle
  return disturbed;
}

function renderHunk(lines, from, to) {
  const out = [];
  const headEnd = Math.min(from + EDGE_LINES - 1, to);
  for (let i = from; i <= headEnd; i += 1) out.push(`${i + 1}\t${lines[i]}`);
  if (to - from + 1 > MAX_HUNK_LINES) {
    const elided = to - from + 1 - 2 * EDGE_LINES;
    out.push(`…\t${elided} lines elided (${from + EDGE_LINES + 1}–${from + EDGE_LINES + elided})`);
    for (let i = to - EDGE_LINES + 1; i <= to; i += 1) out.push(`${i + 1}\t${lines[i]}`);
  } else {
    for (let i = headEnd + 1; i <= to; i += 1) out.push(`${i + 1}\t${lines[i]}`);
  }
  return { firstLine: from + 1, lastLine: to + 1, rendered: out.length, text: out.join("\n") };
}

/**
 * @param patches  array of patch objects
 * @param files    Map<path, string> current contents; a missing key means the
 *                 file could not be read
 * @param mode     "atomic" | "independent"
 * @returns { ok, results, writes }  `writes` is Map<path, string>, empty when
 *          an atomic batch failed.
 */
export function apply(patches, files, mode = "atomic") {
  const buffers = new Map();
  const results = [];
  // Index of the last patch that actually rewrote each file, so a later failure
  // on that file can name the culprit rather than just the symptom.
  const lastWriter = new Map();
  let anyFailure = false;

  for (const [i, patch] of patches.entries()) {
    const problem = validate(patch, i);
    if (problem) {
      results.push({ index: i, file: patch?.file, ok: false, error: problem });
      anyFailure = true;
      continue;
    }
    if (!files.has(patch.file)) {
      results.push({ index: i, file: patch.file, ok: false, error: "file could not be read" });
      anyFailure = true;
      continue;
    }
    // Later patches see earlier ones' results, so a batch can build on itself.
    const current = buffers.has(patch.file) ? buffers.get(patch.file) : files.get(patch.file);
    const outcome = applyOne(current, patch);
    if (outcome.error) {
      const failure = {
        index: i,
        file: patch.file,
        ok: false,
        error: outcome.error,
        found: outcome.found,
        matches: outcome.matches,
        // The count was taken against this file as earlier same-batch patches
        // had already modified it, not against the disk file. The caller
        // usually knows this, but at a count mismatch it is exactly the fact
        // needed to interpret the number.
        sawModifiedBuffer: buffers.has(patch.file) || undefined,
      };
      // Distinguish "your model of the file is wrong" from "an earlier patch in
      // THIS batch moved the ground under you". They read identically at the
      // point of failure but demand opposite responses: re-read the file, versus
      // re-order or rewrite this patch and leave the file alone. Only the second
      // is detectable here, by re-asking the question of the pre-batch text.
      if (buffers.has(patch.file) && countMatches(files.get(patch.file), patch) === (patch.expect ?? 1)) {
        failure.invalidatedBy = lastWriter.get(patch.file);
      }
      results.push(failure);
      anyFailure = true;
      continue;
    }
    buffers.set(patch.file, outcome.text);
    lastWriter.set(patch.file, i);
    results.push({ index: i, file: patch.file, ok: true, replacements: outcome.count });
  }

  // Atomic means nothing reaches disk unless every patch validated. Note this
  // is decided after evaluating all of them, so the report still names every
  // failure rather than stopping at the first.
  if (mode === "atomic" && anyFailure) {
    return { ok: false, results, writes: new Map() };
  }

  const writes = new Map();
  for (const [path, text] of buffers) {
    if (text !== files.get(path)) writes.set(path, text);
  }
  return { ok: !anyFailure, results, writes };
}
