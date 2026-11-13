import React, { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import {
  autocompletion,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { createIdeCompletionSource } from '../services/editorCompletions';
import { detectIndentWidth, vscodeIndentGuides } from '../services/indentGuides';
import { CursorPosition, SearchHit } from '../types/ide';

interface CodeEditorProps {
  filePath: string;
  value: string;
  targetLine?: number | null;
  workspaceSymbols?: SearchHit[];
  onChange: (nextValue: string) => void;
  onSave: () => void;
  onCursorChange: (pos: CursorPosition) => void;
}

function getLanguageExtension(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.rs')) return rust();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return javascript({ typescript: true, jsx: lower.endsWith('.tsx') });
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs')) {
    return javascript({ jsx: lower.endsWith('.jsx') });
  }
  if (lower.endsWith('.py')) return python();
  if (lower.endsWith('.json')) return json();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return html();
  if (lower.endsWith('.css')) return css();
  if (lower.endsWith('.md')) return markdown();
  return [];
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  filePath,
  value,
  targetLine,
  workspaceSymbols = [],
  onChange,
  onSave,
  onCursorChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef(new Compartment());

  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursorChange);
  const workspaceSymbolsRef = useRef(workspaceSymbols);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onCursorRef.current = onCursorChange;
  workspaceSymbolsRef.current = workspaceSymbols;

  useEffect(() => {
    if (!containerRef.current) return;

    const detectedIndent = detectIndentWidth(value, filePath);

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        oneDark,
        EditorState.tabSize.of(detectedIndent),
        indentUnit.of(' '.repeat(detectedIndent)),
        vscodeIndentGuides(detectedIndent),
        langCompartmentRef.current.of(getLanguageExtension(filePath)),
        autocompletion({
          override: [
            createIdeCompletionSource(filePath, () => workspaceSymbolsRef.current),
          ],
          activateOnTyping: true,
          icons: true,
          maxRenderedOptions: 40,
        }),
        keymap.of([
          ...completionKeymap,
          {
            key: 'Ctrl-Space',
            run: startCompletion,
          },
          indentWithTab,
          {
            key: 'Mod-s',
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const lineInfo = update.state.doc.lineAt(head);
            onCursorRef.current({
              line: lineInfo.number,
              col: head - lineInfo.from + 1,
            });
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [filePath]);

  // Synchronize external value updates (e.g., accepted AI patch or file reload)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  // Jump to symbol line if specified
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !targetLine || targetLine < 1) return;
    const maxLine = view.state.doc.lines;
    const clampedLine = Math.min(targetLine, maxLine);
    const lineObj = view.state.doc.line(clampedLine);
    view.dispatch({
      selection: { anchor: lineObj.from },
      effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
    });
    view.focus();
  }, [targetLine, filePath]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
};
