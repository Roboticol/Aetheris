import { Completion, CompletionContext, CompletionResult, snippetCompletion } from '@codemirror/autocomplete';
import { SearchHit } from '../types/ide';

type LangFamily = 'rust' | 'typescript' | 'python' | 'css' | 'html' | 'json' | 'markdown' | 'generic';

export function detectLangFamily(filePath: string): LangFamily {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.rs')) return 'rust';
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs')
  ) {
    return 'typescript';
  }
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.css') || lower.endsWith('.scss')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md')) return 'markdown';
  return 'generic';
}

const RUST_COMPLETIONS: Completion[] = [
  ...['fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'match', 'if', 'else', 'for', 'in', 'while', 'loop', 'use', 'mod', 'crate', 'self', 'Self', 'super', 'async', 'await', 'return', 'where', 'type', 'const', 'static', 'unsafe', 'as', 'ref', 'move', 'dyn'].map(
    (label): Completion => ({ label, type: 'keyword', detail: 'keyword' })
  ),
  ...['String', 'str', 'Vec', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err', 'HashMap', 'HashSet', 'BTreeMap', 'Box', 'Arc', 'Rc', 'Path', 'PathBuf', 'usize', 'isize', 'u8', 'u16', 'u32', 'u64', 'i32', 'i64', 'f64', 'bool'].map(
    (label): Completion => ({ label, type: 'type', detail: 'std' })
  ),
  ...['println!', 'eprintln!', 'format!', 'vec!', 'panic!', 'todo!', 'assert_eq!', 'matches!', 'dbg!'].map(
    (label): Completion => ({ label, type: 'function', detail: 'macro' })
  ),
  snippetCompletion('fn ${name}(${params}) -> ${Ret} {\n    ${}\n}', {
    label: 'fn',
    detail: 'function snippet',
    type: 'function',
  }),
  snippetCompletion('struct ${Name} {\n    ${field}: ${Type},\n}', {
    label: 'struct',
    detail: 'struct snippet',
    type: 'class',
  }),
  snippetCompletion('impl ${Target} {\n    ${}\n}', {
    label: 'impl',
    detail: 'impl block',
    type: 'interface',
  }),
  snippetCompletion('match ${expr} {\n    ${pattern} => ${result},\n    _ => ${fallback},\n}', {
    label: 'match',
    detail: 'match arm',
    type: 'keyword',
  }),
];

const TS_COMPLETIONS: Completion[] = [
  ...['const', 'let', 'var', 'function', 'async', 'await', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'import', 'export', 'from', 'type', 'interface', 'class', 'extends', 'implements', 'enum', 'readonly', 'typeof', 'keyof', 'as', 'true', 'false', 'null', 'undefined'].map(
    (label): Completion => ({ label, type: 'keyword', detail: 'keyword' })
  ),
  ...['Promise', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Array', 'Map', 'Set', 'Error', 'Response', 'Request', 'URL', 'AbortController', 'string', 'number', 'boolean', 'void', 'unknown', 'never'].map(
    (label): Completion => ({ label, type: 'type', detail: 'builtin' })
  ),
  ...['console.log', 'console.error', 'JSON.stringify', 'JSON.parse', 'Object.keys', 'Object.entries', 'Object.values', 'Array.from', 'Promise.all', 'fetch', 'setTimeout', 'clearTimeout', 'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef'].map(
    (label): Completion => ({ label, type: 'function', detail: 'api' })
  ),
  snippetCompletion('function ${name}(${params}): ${void} {\n  ${}\n}', {
    label: 'function',
    detail: 'function snippet',
    type: 'function',
  }),
  snippetCompletion('interface ${Name} {\n  ${prop}: ${string};\n}', {
    label: 'interface',
    detail: 'interface snippet',
    type: 'interface',
  }),
  snippetCompletion('try {\n  ${}\n} catch (${err}) {\n  \n}', {
    label: 'try',
    detail: 'try/catch block',
    type: 'keyword',
  }),
];

const PYTHON_COMPLETIONS: Completion[] = [
  ...['def', 'class', 'async', 'await', 'import', 'from', 'as', 'return', 'yield', 'if', 'elif', 'else', 'for', 'in', 'while', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue', 'lambda', 'True', 'False', 'None', 'and', 'or', 'not', 'is'].map(
    (label): Completion => ({ label, type: 'keyword', detail: 'keyword' })
  ),
  ...['print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'isinstance', 'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'Optional', 'List', 'Dict', 'Any'].map(
    (label): Completion => ({ label, type: 'function', detail: 'builtin' })
  ),
  snippetCompletion('def ${name}(${self}):\n    ${pass}', {
    label: 'def',
    detail: 'function snippet',
    type: 'function',
  }),
];

const CSS_COMPLETIONS: Completion[] = [
  ...['display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'grid-template-columns', 'position', 'inset', 'width', 'height', 'padding', 'margin', 'border', 'border-radius', 'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'overflow', 'transition', 'cursor', 'z-index'].map(
    (label): Completion => ({ label: `${label}: `, displayLabel: label, type: 'property', detail: 'css' })
  ),
];

const HTML_COMPLETIONS: Completion[] = [
  ...['div', 'span', 'section', 'main', 'header', 'footer', 'nav', 'button', 'input', 'textarea', 'form', 'label', 'a', 'img', 'ul', 'li', 'h1', 'h2', 'p', 'code', 'pre'].map(
    (tag): Completion => ({ label: tag, type: 'keyword', detail: 'tag' })
  ),
];

function getBaseCompletions(family: LangFamily): Completion[] {
  switch (family) {
    case 'rust':
      return RUST_COMPLETIONS;
    case 'typescript':
      return TS_COMPLETIONS;
    case 'python':
      return PYTHON_COMPLETIONS;
    case 'css':
      return CSS_COMPLETIONS;
    case 'html':
      return HTML_COMPLETIONS;
    default:
      return [];
  }
}

function extractDocumentCompletions(text: string): Completion[] {
  const seen = new Map<string, Completion>();

  // Extract explicit declarations first for richer icon types
  const declPatterns: Array<{ re: RegExp; type: string }> = [
    { re: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g, type: 'function' },
    { re: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, type: 'function' },
    { re: /\bdef\s+([A-Za-z_]\w*)/g, type: 'function' },
    { re: /\b(?:pub\s+)?struct\s+([A-Za-z_]\w*)/g, type: 'class' },
    { re: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g, type: 'class' },
    { re: /\b(?:pub\s+)?enum\s+([A-Za-z_]\w*)/g, type: 'enum' },
    { re: /\b(?:export\s+)?(?:interface|trait)\s+([A-Za-z_$][\w$]*)/g, type: 'interface' },
    { re: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g, type: 'type' },
    { re: /\b(?:const|let|static)\s+(?:mut\s+)?([A-Za-z_$][\w$]*)/g, type: 'variable' },
  ];

  for (const { re, type } of declPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (name && name.length >= 2 && !seen.has(name)) {
        seen.set(name, { label: name, type, detail: 'local', boost: 2 });
      }
    }
  }

  // Fallback word identifiers from current document
  const wordRe = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
  let wm: RegExpExecArray | null;
  let count = 0;
  while ((wm = wordRe.exec(text)) !== null && count < 400) {
    const word = wm[1];
    if (!seen.has(word)) {
      seen.set(word, { label: word, type: 'variable', detail: 'buffer' });
      count++;
    }
  }

  return Array.from(seen.values());
}

function mapSymbolKindToCompletionType(kind?: string | null): string {
  if (!kind) return 'variable';
  const k = kind.toLowerCase();
  if (k.includes('fn') || k.includes('func') || k.includes('method')) return 'function';
  if (k.includes('struct') || k.includes('class')) return 'class';
  if (k.includes('interface') || k.includes('trait')) return 'interface';
  if (k.includes('enum')) return 'enum';
  if (k.includes('type')) return 'type';
  if (k.includes('const')) return 'constant';
  return 'variable';
}

export function createIdeCompletionSource(
  filePath: string,
  getWorkspaceSymbols: () => SearchHit[]
) {
  const family = detectLangFamily(filePath);
  const baseCompletions = getBaseCompletions(family);

  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$!]+/);
    const afterDotOrColon = context.matchBefore(/(?:\.|::)$/);

    if (!word && !afterDotOrColon && !context.explicit) {
      return null;
    }

    const from = word ? word.from : context.pos;
    if (word && word.from === word.to && !context.explicit && !afterDotOrColon) {
      return null;
    }

    const merged = new Map<string, Completion>();

    for (const item of baseCompletions) {
      merged.set(item.label, item);
    }

    const docText = context.state.doc.toString();
    for (const item of extractDocumentCompletions(docText)) {
      if (!merged.has(item.label)) {
        merged.set(item.label, item);
      } else {
        // Prefer local declaration metadata if it matches a keyword? Keep keywords as keywords.
        const existing = merged.get(item.label)!;
        if (existing.type !== 'keyword') {
          merged.set(item.label, item);
        }
      }
    }

    for (const hit of getWorkspaceSymbols()) {
      const name = hit.symbolName;
      if (!name || name.length < 2) continue;
      if (!merged.has(name)) {
        merged.set(name, {
          label: name,
          type: mapSymbolKindToCompletionType(hit.symbolKind),
          detail: hit.filePath.split('/').pop() ?? hit.filePath,
          boost: 1,
        });
      }
    }

    return {
      from,
      options: Array.from(merged.values()),
      validFor: /^[\w$!]*$/,
    };
  };
}
