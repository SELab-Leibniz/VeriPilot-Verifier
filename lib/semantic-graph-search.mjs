import { describeSemanticSymbol } from './semantic-graph-links.mjs';

const genericWords = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it', 'of', 'on',
  'or', 'should', 'the', 'to', 'when', 'with']);

function words(text) {
  return (text.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !genericWords.has(word));
}

export function createSemanticSearch(sources) {
  const index = [], frequency = new Map();
  for (const [file, source] of sources) {
    const pathTerms = new Set(words(file));
    for (const record of source.symbols) {
      const phrase = words(record.item.symbol);
      if (!phrase.length) continue;
      const name = new Set(phrase), owner = new Set(words(record.item.owner ?? ''));
      for (const word of new Set([...name, ...owner])) frequency.set(word, (frequency.get(word) ?? 0) + 1);
      index.push({ record, name, owner, pathTerms, phrase: phrase.join(' ') });
    }
  }
  return (query, file) => {
    const terms = [...new Set(words(query))].slice(0, 32);
    if (!terms.length) return [];
    const phrase = terms.join(' ');
    const weighted = terms.map(term => [term, Math.log1p(index.length / (1 + (frequency.get(term) ?? 0)))]);
    const matches = [];
    for (const entry of index) {
      if (file && entry.record.item.path !== file) continue;
      const matched = terms.filter(term => entry.name.has(term));
      if (!matched.length) continue;
      let score = 0;
      for (const [term, weight] of weighted) {
        if (entry.name.has(term)) score += weight * 3;
        else if (entry.owner.has(term)) score += weight;
        else if (entry.pathTerms.has(term)) score += weight * 0.35;
      }
      if (entry.phrase === phrase) score += 8;
      matches.push({ entry, score: score / Math.sqrt(entry.name.size + 1), matched });
    }
    return matches.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length)
      .map(({ entry, matched }) => ({ ...describeSemanticSymbol(entry.record), matched }));
  };
}
