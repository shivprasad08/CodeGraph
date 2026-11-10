// Languages CodeGraph reads (mirrors backend/languages/registry.py).
// `full` marks full support (scope-aware resolution); the rest are linked by name.

export const LANGUAGES = {
  python: { name: 'Python', tag: 'PY', hljs: 'python', full: true },
  javascript: { name: 'JavaScript', tag: 'JS', hljs: 'javascript' },
  typescript: { name: 'TypeScript', tag: 'TS', hljs: 'typescript' },
  java: { name: 'Java', tag: 'JAVA', hljs: 'java' },
  go: { name: 'Go', tag: 'GO', hljs: 'go' },
  rust: { name: 'Rust', tag: 'RS', hljs: 'rust' },
  c: { name: 'C', tag: 'C', hljs: 'c' },
  cpp: { name: 'C++', tag: 'C++', hljs: 'cpp' },
  csharp: { name: 'C#', tag: 'C#', hljs: 'csharp' },
  ruby: { name: 'Ruby', tag: 'RB', hljs: 'ruby' },
  php: { name: 'PHP', tag: 'PHP', hljs: 'php' },
  kotlin: { name: 'Kotlin', tag: 'KT', hljs: 'kotlin' },
  swift: { name: 'Swift', tag: 'SWIFT', hljs: 'swift' },
  scala: { name: 'Scala', tag: 'SCALA', hljs: 'scala' },
  lua: { name: 'Lua', tag: 'LUA', hljs: 'lua' },
};

const EXTENSIONS = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', java: 'java', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala', sc: 'scala', lua: 'lua',
};

/** Language of a node: its `lang`, else from the file extension (graphs analysed before multi-language support). */
export function langOf(node) {
  if (node?.lang) return node.lang;
  const path = node?.file || node?.id || '';
  const ext = path.split('/').pop().split('::')[0].split('.').pop()?.toLowerCase();
  return EXTENSIONS[ext] ?? null;
}

export const languageName = (lang) => LANGUAGES[lang]?.name ?? lang ?? '';
export const languageTag = (lang) => LANGUAGES[lang]?.tag ?? (lang ? lang.toUpperCase() : '');

/** [{lang, name, files, loc, share}] from graph.languages, or counted from file nodes for older graphs. */
export function languageBreakdown(graph) {
  let rows = graph?.languages;
  if (!rows?.length) {
    const counts = new Map();
    for (const n of graph?.nodes ?? []) {
      if (n.type !== 'file') continue;
      const lang = langOf(n);
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    rows = [...counts].map(([lang, files]) => ({ lang, files, loc: 0 }));
  }
  const byLoc = rows.some((r) => r.loc > 0);
  const total = rows.reduce((sum, r) => sum + (byLoc ? r.loc : r.files), 0) || 1;
  return rows
    .map((r) => ({ lang: r.lang, name: r.label || languageName(r.lang), files: r.files, loc: r.loc ?? 0, share: (byLoc ? r.loc : r.files) / total }))
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
}
