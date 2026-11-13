import { Extension, Range } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';

const INACTIVE_GUIDE_COLOR = 'rgba(139, 146, 165, 0.22)';
const ACTIVE_GUIDE_COLOR = 'rgba(129, 140, 248, 0.72)';
const CURSOR_ON_GUIDE_COLOR = 'rgba(165, 180, 252, 0.95)';

export function detectIndentWidth(docText: string, filePath: string): number {
  const lower = filePath.toLowerCase();
  const fallback =
    lower.endsWith('.rs') || lower.endsWith('.py') || lower.endsWith('.toml') ? 4 : 2;

  const counts = new Map<number, number>();
  const lines = docText.split('\n');
  const limit = Math.min(lines.length, 150);

  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;
    const match = line.match(/^( +)/);
    if (match) {
      const len = match[1].length;
      if (len >= 2 && len <= 8) {
        counts.set(len, (counts.get(len) ?? 0) + 1);
      }
    }
  }

  if (counts.has(2) && (counts.get(2) ?? 0) >= 2) return 2;
  if (counts.has(4) && (counts.get(4) ?? 0) >= 2) return 4;
  if (counts.has(2)) return 2;
  if (counts.has(4)) return 4;
  return fallback;
}

function countIndentColumns(lineText: string, tabSize: number): {
  cols: number;
  wsChars: number;
  isBlank: boolean;
} {
  let cols = 0;
  let wsChars = 0;
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === ' ') {
      cols += 1;
      wsChars += 1;
    } else if (ch === '\t') {
      const step = tabSize - (cols % tabSize);
      cols += step;
      wsChars += 1;
    } else {
      return { cols, wsChars, isBlank: false };
    }
  }
  return { cols, wsChars, isBlank: true };
}

interface LineIndentMeta {
  lineNumber: number;
  from: number;
  rawLevel: number;
  effectiveLevel: number;
  isBlank: boolean;
  text: string;
}

function computeLineIndents(
  view: EditorView,
  startLine: number,
  endLine: number,
  indentWidth: number
): LineIndentMeta[] {
  const doc = view.state.doc;
  const tabSize = view.state.tabSize || indentWidth;
  const metas: LineIndentMeta[] = [];

  for (let ln = startLine; ln <= endLine; ln++) {
    const line = doc.line(ln);
    const { cols, isBlank } = countIndentColumns(line.text, tabSize);
    const rawLevel = Math.floor(cols / indentWidth);
    metas.push({
      lineNumber: ln,
      from: line.from,
      rawLevel,
      effectiveLevel: rawLevel,
      isBlank,
      text: line.text,
    });
  }

  // Forward / backward context for blank lines so vertical guides stay continuous across empty lines
  const prevEffective = new Array<number>(metas.length).fill(0);
  let lastNonBlankLevel = 0;
  let lastNonBlankOpensBlock = false;
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    if (!m.isBlank) {
      lastNonBlankLevel = m.rawLevel;
      const trimmed = m.text.trim();
      lastNonBlankOpensBlock =
        trimmed.endsWith('{') ||
        trimmed.endsWith('[') ||
        trimmed.endsWith('(') ||
        trimmed.endsWith(':');
      prevEffective[i] = m.rawLevel;
    } else {
      prevEffective[i] = lastNonBlankOpensBlock ? lastNonBlankLevel + 1 : lastNonBlankLevel;
    }
  }

  let nextNonBlankLevel = 0;
  let nextNonBlankClosesBlock = false;
  for (let i = metas.length - 1; i >= 0; i--) {
    const m = metas[i];
    if (!m.isBlank) {
      nextNonBlankLevel = m.rawLevel;
      const trimmed = m.text.trim();
      nextNonBlankClosesBlock =
        trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith(')');
    } else {
      const nextEff = nextNonBlankClosesBlock ? nextNonBlankLevel + 1 : nextNonBlankLevel;
      m.effectiveLevel = Math.max(0, Math.min(prevEffective[i], nextEff));
    }
  }

  return metas;
}

function buildIndentGuideDecorations(view: EditorView, indentWidth: number): DecorationSet {
  const doc = view.state.doc;
  const totalLines = doc.lines;
  if (totalLines === 0) return Decoration.none;

  const vp = view.viewport;
  const vpStartLine = doc.lineAt(vp.from).number;
  const vpEndLine = doc.lineAt(vp.to).number;

  // Include generous context around viewport and cursor so active block guides resolve accurately
  const head = view.state.selection.main.head;
  const cursorLineObj = doc.lineAt(head);
  const cursorLineNum = cursorLineObj.number;

  const contextStart = Math.max(1, Math.min(vpStartLine, cursorLineNum) - 120);
  const contextEnd = Math.min(totalLines, Math.max(vpEndLine, cursorLineNum) + 120);

  const metas = computeLineIndents(view, contextStart, contextEnd, indentWidth);
  const cursorIdx = cursorLineNum - contextStart;
  const cursorMeta = metas[cursorIdx];

  // Determine cursor column & whether cursor sits directly on an indentation guide
  const tabSize = view.state.tabSize || indentWidth;
  const beforeCursor = cursorLineObj.text.slice(0, head - cursorLineObj.from);
  const cursorCols = countIndentColumns(beforeCursor, tabSize);
  const inLeadingWhitespace = cursorCols.wsChars === beforeCursor.length;

  let activeGuideIdx: number | null = null;
  let cursorDirectGuideIdx: number | null = null;

  if (cursorMeta) {
    if (inLeadingWhitespace && cursorCols.cols % indentWidth === 0) {
      const candidate = cursorCols.cols / indentWidth;
      if (candidate < cursorMeta.effectiveLevel) {
        activeGuideIdx = candidate;
        cursorDirectGuideIdx = candidate;
      }
    }

    if (activeGuideIdx === null) {
      if (cursorMeta.effectiveLevel > 0) {
        activeGuideIdx = cursorMeta.effectiveLevel - 1;
      } else {
        const trimmed = cursorMeta.text.trim();
        const nextMeta = metas[cursorIdx + 1];
        const prevMeta = metas[cursorIdx - 1];
        if (
          (trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith('(') || trimmed.endsWith(':')) &&
          nextMeta &&
          nextMeta.effectiveLevel > cursorMeta.rawLevel
        ) {
          activeGuideIdx = cursorMeta.rawLevel;
        } else if (
          (trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith(')')) &&
          prevMeta &&
          prevMeta.effectiveLevel > cursorMeta.rawLevel
        ) {
          activeGuideIdx = cursorMeta.rawLevel;
        }
      }
    }
  }

  // Determine contiguous active block line range for activeGuideIdx
  let activeRangeStart = -1;
  let activeRangeEnd = -1;
  if (activeGuideIdx !== null && cursorMeta) {
    // Anchor inside the indented block even if cursor is on the opening/closing brace line
    let anchorIdx = cursorIdx;
    if (cursorMeta.effectiveLevel <= activeGuideIdx) {
      const nextMeta = metas[cursorIdx + 1];
      const prevMeta = metas[cursorIdx - 1];
      if (nextMeta && nextMeta.effectiveLevel > activeGuideIdx) {
        anchorIdx = cursorIdx + 1;
      } else if (prevMeta && prevMeta.effectiveLevel > activeGuideIdx) {
        anchorIdx = cursorIdx - 1;
      }
    }

    if (metas[anchorIdx] && metas[anchorIdx].effectiveLevel > activeGuideIdx) {
      activeRangeStart = anchorIdx;
      while (
        activeRangeStart > 0 &&
        metas[activeRangeStart - 1].effectiveLevel > activeGuideIdx
      ) {
        activeRangeStart -= 1;
      }
      activeRangeEnd = anchorIdx;
      while (
        activeRangeEnd < metas.length - 1 &&
        metas[activeRangeEnd + 1].effectiveLevel > activeGuideIdx
      ) {
        activeRangeEnd += 1;
      }
    }
  }

  const decorations: Range<Decoration>[] = [];

  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    if (meta.lineNumber < vpStartLine || meta.lineNumber > vpEndLine) continue;
    if (meta.effectiveLevel <= 0) continue;

    const levels = Math.min(meta.effectiveLevel, 16);
    const images: string[] = [];
    const positions: string[] = [];
    const sizes: string[] = [];
    const repeats: string[] = [];

    const inActiveBlock = i >= activeRangeStart && i <= activeRangeEnd;

    for (let g = 0; g < levels; g++) {
      let color = INACTIVE_GUIDE_COLOR;
      if (activeGuideIdx !== null && g === activeGuideIdx && inActiveBlock) {
        color =
          i === cursorIdx && cursorDirectGuideIdx === g
            ? CURSOR_ON_GUIDE_COLOR
            : ACTIVE_GUIDE_COLOR;
      }
      images.push(`linear-gradient(${color}, ${color})`);
      positions.push(`${g * indentWidth}ch 0`);
      sizes.push('1px 100%');
      repeats.push('no-repeat');
    }

    const style = [
      `background-image: ${images.join(', ')}`,
      `background-position: ${positions.join(', ')}`,
      `background-size: ${sizes.join(', ')}`,
      `background-repeat: ${repeats.join(', ')}`,
      'background-origin: content-box',
    ].join('; ');

    decorations.push(
      Decoration.line({
        attributes: { style },
      }).range(meta.from)
    );
  }

  return Decoration.set(decorations, true);
}

export function vscodeIndentGuides(indentWidth: number): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildIndentGuideDecorations(view, indentWidth);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildIndentGuideDecorations(update.view, indentWidth);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
