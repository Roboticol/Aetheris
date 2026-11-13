import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface MarkdownContentProps {
  content: string;
  onOpenFile?: (path: string) => void;
  className?: string;
}

interface ListItem {
  text: string;
  subItems: Array<{ ordered: boolean; text: string }>;
}

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; start: number; items: ListItem[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

const PROSE_FENCE_LANGS = new Set(['', 'markdown', 'md', 'text', 'txt', 'plaintext']);

function looksLikeMarkdownProse(text: string): boolean {
  return (
    /^#{1,6}\s+\S/m.test(text) ||
    /\*\*[^*\n]{2,}\*\*/.test(text) ||
    /^[-*+]\s+\*\*[^*\n]+\*\*/m.test(text) ||
    /^\d+[.)]\s+\*\*[^*\n]+\*\*/m.test(text)
  );
}

function unwrapOuterMarkdownFence(raw: string): string {
  let current = raw.replace(/\r\n/g, '\n');
  for (let pass = 0; pass < 2; pass++) {
    const trimmed = current.trim();
    const match = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\s*$/.exec(trimmed);
    if (!match) break;
    const lang = match[2].trim().toLowerCase();
    const body = match[3];
    if (
      lang === 'markdown' ||
      lang === 'md' ||
      (PROSE_FENCE_LANGS.has(lang) && looksLikeMarkdownProse(body))
    ) {
      current = body;
    } else {
      break;
    }
  }
  return current;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseMarkdownBlocks(raw: string, depth = 0): Block[] {
  const normalized = unwrapOuterMarkdownFence(raw);
  const lines = normalized.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block ```lang
    const fenceMatch = /^(`{3,}|~{3,})\s*([^\s`]*)/.exec(trimmed);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = (fenceMatch[2] ?? '').trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const closeLine = lines[i].trim();
        const closeRe = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
        if (closeRe.test(closeLine)) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      const codeText = codeLines.join('\n');
      const langLower = lang.toLowerCase();
      if (
        depth < 3 &&
        (langLower === 'markdown' ||
          langLower === 'md' ||
          (PROSE_FENCE_LANGS.has(langLower) && looksLikeMarkdownProse(codeText)))
      ) {
        blocks.push(...parseMarkdownBlocks(codeText, depth + 1));
      } else {
        blocks.push({ type: 'code', lang, code: codeText });
      }
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // ATX Heading (# .. ######)
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].replace(/\s+#+\s*$/, ''),
      });
      i++;
      continue;
    }

    // GFM Table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    // Top-level Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const topMatch = /^[-*+]\s+(.*)$/.exec(cur);
        if (topMatch) {
          items.push({ text: topMatch[1], subItems: [] });
          i++;
        } else if (/^\s{2,}[-*+]\s+(.*)$/.test(cur) && items.length > 0) {
          const sub = /^\s{2,}[-*+]\s+(.*)$/.exec(cur)!;
          items[items.length - 1].subItems.push({ ordered: false, text: sub[1] });
          i++;
        } else if (/^\s{2,}\d+[.)]\s+(.*)$/.test(cur) && items.length > 0) {
          const sub = /^\s{2,}\d+[.)]\s+(.*)$/.exec(cur)!;
          items[items.length - 1].subItems.push({ ordered: true, text: sub[1] });
          i++;
        } else if (/^\s{2,}\S/.test(cur) && items.length > 0) {
          const last = items[items.length - 1];
          if (last.subItems.length > 0) {
            last.subItems[last.subItems.length - 1].text += ` ${cur.trim()}`;
          } else {
            last.text += ` ${cur.trim()}`;
          }
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Top-level Ordered list
    const olFirst = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (olFirst) {
      const start = Number(olFirst[1]) || 1;
      const items: ListItem[] = [{ text: olFirst[2], subItems: [] }];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const olNext = /^(\d+)[.)]\s+(.*)$/.exec(cur);
        if (olNext) {
          items.push({ text: olNext[2], subItems: [] });
          i++;
        } else if (/^\s{2,}[-*+]\s+(.*)$/.test(cur) && items.length > 0) {
          const sub = /^\s{2,}[-*+]\s+(.*)$/.exec(cur)!;
          items[items.length - 1].subItems.push({ ordered: false, text: sub[1] });
          i++;
        } else if (/^\s{2,}\d+[.)]\s+(.*)$/.test(cur) && items.length > 0) {
          const sub = /^\s{2,}\d+[.)]\s+(.*)$/.exec(cur)!;
          items[items.length - 1].subItems.push({ ordered: true, text: sub[1] });
          i++;
        } else if (/^\s{2,}\S/.test(cur) && items.length > 0) {
          const last = items[items.length - 1];
          if (last.subItems.length > 0) {
            last.subItems[last.subItems.length - 1].text += ` ${cur.trim()}`;
          } else {
            last.text += ` ${cur.trim()}`;
          }
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: 'ol', start, items });
      continue;
    }

    // Paragraph (collect contiguous plain lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (
        !curTrim ||
        /^(`{3,}|~{3,})/.test(curTrim) ||
        /^(#{1,6})\s+/.test(curTrim) ||
        /^>\s?/.test(curTrim) ||
        /^[-*+]\s+/.test(cur) ||
        /^\d+[.)]\s+/.test(cur) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(curTrim)
      ) {
        break;
      }
      paraLines.push(curTrim);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

function isLikelyWorkspaceFile(text: string): boolean {
  return (
    text.length > 0 &&
    text.length < 160 &&
    !text.includes(' ') &&
    /[./]/.test(text) &&
    /^[A-Za-z0-9_@./-]+$/.test(text) &&
    !text.startsWith('http')
  );
}

function renderInline(
  text: string,
  onOpenFile?: (path: string) => void,
  keyPrefix = 'in'
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let idx = 0;

  const tokenRe =
    /(`[^`\n]+`)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(\*\*\*[^*\n]+\*\*\*|___[^_\n]+___)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|(?:^|(?<=[\s(]))_[^_\n]+_(?=$|[\s).,!?:;]))|(~~[^~\n]+~~)/;

  while (remaining.length > 0) {
    const match = tokenRe.exec(remaining);
    if (!match) {
      nodes.push(remaining);
      break;
    }

    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }

    const full = match[0];
    const key = `${keyPrefix}-${idx++}`;

    if (match[1]) {
      const codeText = full.slice(1, -1);
      if (onOpenFile && isLikelyWorkspaceFile(codeText)) {
        nodes.push(
          <button
            key={key}
            type="button"
            onClick={() => onOpenFile(codeText)}
            title={`Open ${codeText}`}
            className="mx-0.5 inline rounded bg-[#1E222E] px-1.5 py-0.5 font-mono text-[11.5px] text-[#A5B4FC] hover:bg-[#272B38] hover:text-white transition-colors"
          >
            {codeText}
          </button>
        );
      } else {
        nodes.push(
          <code
            key={key}
            className="mx-0.5 rounded bg-[#1E222E] px-1.5 py-0.5 font-mono text-[11.5px] text-[#C7D2FE]"
          >
            {codeText}
          </code>
        );
      }
    } else if (match[2]) {
      const labelEnd = full.indexOf('](');
      const label = full.slice(1, labelEnd);
      const href = match[3];
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#818CF8] underline decoration-[#818CF8]/50 hover:text-[#A5B4FC]"
        >
          {renderInline(label, onOpenFile, `${key}-l`)}
        </a>
      );
    } else if (match[4]) {
      const inner = full.slice(3, -3);
      nodes.push(
        <strong key={key} className="font-semibold italic text-[#F3F4F6]">
          {renderInline(inner, onOpenFile, `${key}-bi`)}
        </strong>
      );
    } else if (match[5]) {
      const inner = full.slice(2, -2);
      nodes.push(
        <strong key={key} className="font-semibold text-[#F3F4F6]">
          {renderInline(inner, onOpenFile, `${key}-b`)}
        </strong>
      );
    } else if (match[6]) {
      const inner = full.slice(1, -1);
      nodes.push(
        <em key={key} className="italic text-[#E6E8EE]">
          {renderInline(inner, onOpenFile, `${key}-i`)}
        </em>
      );
    } else if (match[7]) {
      const inner = full.slice(2, -2);
      nodes.push(
        <del key={key} className="text-[#8B92A5] line-through">
          {renderInline(inner, onOpenFile, `${key}-s`)}
        </del>
      );
    }

    remaining = remaining.slice(match.index + full.length);
  }

  return nodes;
}

const CodeFenceBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[#272B38] bg-[#0B0D12]">
      <div className="flex items-center justify-between border-b border-[#272B38]/80 bg-[#12151E] px-2.5 py-1 text-[10.5px] text-[#8B92A5]">
        <span className="font-mono uppercase tracking-wider">{lang || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-300">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[11.5px] leading-relaxed text-[#E6E8EE]">
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  onOpenFile,
  className = '',
}) => {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className={`space-y-2 text-[12.5px] leading-relaxed text-[#D1D5E0] break-words ${className}`}>
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return <CodeFenceBlock key={idx} lang={block.lang} code={block.code} />;
        }

        if (block.type === 'hr') {
          return <hr key={idx} className="my-2 border-[#272B38]" />;
        }

        if (block.type === 'heading') {
          const sizeClass =
            block.level === 1
              ? 'text-[14.5px] font-bold text-[#F3F4F6] pt-1'
              : block.level === 2
                ? 'text-[13.5px] font-semibold text-[#F3F4F6] pt-1'
                : 'text-[12.5px] font-semibold text-[#E6E8EE] pt-0.5';
          return (
            <div key={idx} className={sizeClass}>
              {renderInline(block.text, onOpenFile, `h-${idx}`)}
            </div>
          );
        }

        if (block.type === 'blockquote') {
          return (
            <blockquote
              key={idx}
              className="border-l-2 border-[#6366F1]/70 pl-3 text-[12px] text-[#B5BBC9] space-y-1"
            >
              {block.lines.map((line, li) => (
                <p key={li}>{renderInline(line, onOpenFile, `bq-${idx}-${li}`)}</p>
              ))}
            </blockquote>
          );
        }

        if (block.type === 'ul') {
          return (
            <ul key={idx} className="space-y-1.5 pl-4 list-disc marker:text-[#8B92A5]">
              {block.items.map((item, li) => (
                <li key={li} className="space-y-1">
                  <div>{renderInline(item.text, onOpenFile, `ul-${idx}-${li}`)}</div>
                  {item.subItems.length > 0 && (
                    <ul className="space-y-1 pl-4 list-[circle] marker:text-[#6B7280]">
                      {item.subItems.map((sub, si) => (
                        <li key={si}>
                          {renderInline(sub.text, onOpenFile, `ul-${idx}-${li}-s-${si}`)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === 'ol') {
          return (
            <ol
              key={idx}
              start={block.start}
              className="space-y-1.5 pl-4 list-decimal marker:font-mono marker:text-[11.5px] marker:text-[#8B92A5]"
            >
              {block.items.map((item, li) => (
                <li key={li} className="space-y-1">
                  <div>{renderInline(item.text, onOpenFile, `ol-${idx}-${li}`)}</div>
                  {item.subItems.length > 0 && (
                    <ul className="space-y-1 pl-4 list-disc marker:text-[#6B7280]">
                      {item.subItems.map((sub, si) => (
                        <li key={si}>
                          {renderInline(sub.text, onOpenFile, `ol-${idx}-${li}-s-${si}`)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === 'table') {
          return (
            <div key={idx} className="overflow-x-auto rounded-md border border-[#272B38]">
              <table className="w-full border-collapse text-left text-[11.5px]">
                <thead className="bg-[#12151E] text-[#E6E8EE]">
                  <tr>
                    {block.headers.map((h, hi) => (
                      <th key={hi} className="border-b border-[#272B38] px-2.5 py-1.5 font-semibold">
                        {renderInline(h, onOpenFile, `th-${idx}-${hi}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#272B38]/70 bg-[#0F1117]/60">
                  {block.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-2.5 py-1.5 text-[#D1D5E0]">
                          {renderInline(cell, onOpenFile, `td-${idx}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={idx}>
            {renderInline(block.text, onOpenFile, `p-${idx}`)}
          </p>
        );
      })}
    </div>
  );
};
