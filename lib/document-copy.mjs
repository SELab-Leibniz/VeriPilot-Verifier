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
  for (let i = 0; i < Math.max(a.length, b.length) && diagnostics.length < 8; i++) {
    if (a[i] === b[i]) continue;
    diagnostics.push({ ruleId: 'DOCUMENT-COPY-MISMATCH', severity: 'error', path: target.relativePath,
      line: Math.min(i + 1, rawB.length), message: `Document differs from declared copy source ${source.relativePath} at physical line ${i + 1}.`,
      evidence: [`source line ${i + 1} = ${quote(rawA[i])}`, `current line ${i + 1} = ${quote(rawB[i])}`],
      suggestion: i >= Math.min(a.length, b.length)
        ? `Preserve EOF/newlines exactly. Native edit: current suffix ${quote(target.content.slice(-120))}; source suffix ${quote(source.content.slice(-120))}.`
        : `Use native edit to replace the current line with the source line exactly, including indentation and literal-block whitespace. Read ${source.relativePath} and ${target.relativePath} if more context is needed.` });
  }
  return diagnostics;
}
