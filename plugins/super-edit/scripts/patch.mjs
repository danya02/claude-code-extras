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
    if (isLiteral) {
      return {
        error:
          found === 0
            ? `no match for the literal text (expected ${expect})`
            : `found ${plural(found, "match", "matches")}, expected ${expect}`,
      };
    }
    return {
      error:
        found === 0
          ? `regex matched nothing (expected ${expect})`
          : `regex matched ${plural(found, "time", "times")}, expected ${expect}`,
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

// Line numbers of every line that differs, so the caller can echo the changed
// regions back. The harness will not do it for us on a Read-only-tracked file.
export function changedRegions(before, after, context = DEFAULT_CONTEXT) {
  const a = before.split("\n");
  const b = after.split("\n");
  // A full diff is overkill here: report the span from the first to the last
  // line that differs, which for the edits this tool makes is tight enough.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const from = Math.max(0, start - context);
  const to = Math.min(b.length - 1, endB + context);
  const lines = [];
  for (let i = from; i <= to; i += 1) lines.push(`${i + 1}\t${b[i]}`);
  return { firstLine: from + 1, lastLine: to + 1, text: lines.join("\n") };
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
      const failure = { index: i, file: patch.file, ok: false, error: outcome.error };
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
