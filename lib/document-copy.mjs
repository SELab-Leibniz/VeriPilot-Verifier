import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
function comparableLines(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const literal = Boolean(fence || marker);
    if (!fence && marker) fence = marker[1];
    else if (fence && marker && marker[1][0] === fence[0]
      && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    return literal ? line : line.replace(/[ \t]+$/u, '');
  });
}

// Comparison only: never normalize a source file or rewrite a target.
export function assessDocumentCopy(expected, actual) {
  return { equivalent: comparableLines(expected).join('\n') === comparableLines(actual).join('\n'),
    exact: expected === actual, expectedSha256: hash(expected), actualSha256: hash(actual),
    policy: 'Exact document content and newlines; trailing spaces/tabs outside fenced literal blocks may differ.' };
}

export function documentCopyDiagnostics(source, target) {
  const a = comparableLines(source.content), b = comparableLines(target.content), diagnostics = [];
  const rawA = source.content.split('\n'), rawB = target.content.split('\n');
  const quote = value => value === undefined ? '<EOF>' : JSON.stringify(value.length > 600 ? value.slice(0,600) + '… [read full current line]' : value);
  const sourceBody = source.content.replace(/\n*$/u, ''), targetBody = target.content.replace(/\n*$/u, '');
  const suffixBody = Array.from(targetBody).slice(-120).join('');
  const oldSuffix = suffixBody + target.content.slice(targetBody.length);
  const newSuffix = suffixBody + source.content.slice(sourceBody.length);
  const eofEdit = sourceBody === targetBody && oldSuffix && oldSuffix !== newSuffix
    && target.content.indexOf(oldSuffix) === target.content.lastIndexOf(oldSuffix)
    ? JSON.stringify({ path: target.relativePath, edits: [{ oldText: oldSuffix, newText: newSuffix }] }).replaceAll(' ', '\\u0020') : null;
  for (let i = 0; i < Math.max(a.length, b.length) && diagnostics.length < 8; i++) {
    if (a[i] === b[i]) continue;
    const whitespaceOnly = rawA[i] !== undefined && rawB[i] !== undefined
      && rawA[i].replace(/[ \t]/gu, '') === rawB[i].replace(/[ \t]/gu, '');
    const exactPatch = whitespaceOnly && rawA[i].length <= 600 && rawB[i].length <= 600
      && !/[\r\n]/u.test(target.relativePath) && rawB.filter(line => line === rawB[i]).length === 1
      ? JSON.stringify({ input: `*** Begin Patch\n*** Update File: ${target.relativePath}\n@@\n-${rawB[i]}\n+${rawA[i]}\n*** End Patch\n` }).replaceAll(' ', '\\u0020') : null;
    diagnostics.push({ ruleId: 'DOCUMENT-COPY-MISMATCH', severity: 'error', path: target.relativePath,
      line: Math.min(i + 1, rawB.length), message: `Document differs from declared copy source ${source.relativePath} at physical line ${i + 1}.`,
      evidence: [`source line ${i + 1} = ${whitespaceOnly ? quote(rawA[i]).replaceAll(' ', '\\u0020') : quote(rawA[i])}`, `current line ${i + 1} = ${whitespaceOnly ? quote(rawB[i]).replaceAll(' ', '\\u0020') : quote(rawB[i])}`,
        ...(whitespaceOnly ? [`Line lengths: source ${rawA[i].length}, current ${rawB[i].length}. Trailing spaces/tabs: source ${rawA[i].match(/[ \t]*$/u)[0].length}, current ${rawB[i].match(/[ \t]*$/u)[0].length}.`] : []),
        ...(exactPatch ? [`native apply_patch arguments = ${exactPatch}`] : []),
        ...(eofEdit && i >= Math.min(a.length, b.length) ? [`native edit arguments = ${eofEdit}`] : [])],
      suggestion: i >= Math.min(a.length, b.length)
        ? eofEdit
          ? `Preserve EOF/newlines exactly. Only trailing newlines differ: use native edit with the exact JSON arguments in evidence. Native apply_patch may treat EOF newline changes as no-ops. These arguments preserve the identical body; review does not modify files.`
          : `Preserve EOF/newlines exactly. Repair earlier content differences first, then use native edit or write to restore the complete source. Do not replace independently truncated source/current suffixes; their starting positions may differ.`
        : whitespaceOnly ? exactPatch
          ? `Use native apply_patch with the exact JSON arguments in evidence; \\u0020 encodes one actual space. This preserves the whitespace-only change. Do not use fuzzy edit, which may report a no-op and terminate the run. The main agent must execute the patch; review does not modify files.`
          : `This is a whitespace-only difference. Native edit tools may normalize it as a no-op and terminate the run. Use native write or an exact native apply_patch with enough surrounding context to restore the source characters. Do not repeat a whitespace-only edit.`
        : `Use native edit to replace the current line with the source line exactly, including indentation and literal-block whitespace. Read ${source.relativePath} and ${target.relativePath} if more context is needed.` });
  }
  return diagnostics;
}
