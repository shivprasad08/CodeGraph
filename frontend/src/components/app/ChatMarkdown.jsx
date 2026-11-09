import { Fragment } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../ui';

// Drop the model's trailing "References:" block; its node ids are shown as chips instead
export const stripReferences = (text) => text.replace(/(?:\n|^)\**References:?\**[\s\S]*$/i, '').trim();

/**
 * Hide the ```diagram JSON block (rendered as a card instead). Also hides a block
 * that is still streaming (no closing fence yet) and a partial opening fence at the end.
 */
export function stripDiagram(text) {
  let out = text.replace(/```diagram[\s\S]*?(?:```|$)/g, '');
  // A partial fence at the very end ("`", "``", "```dia"…) may be a diagram block
  // that is still arriving. Fences start a line; it is an opener only when the
  // fences before it are balanced (otherwise it closes a normal code block).
  const tail = out.match(/(^|\n)`{1,3}(?:d(?:i(?:a(?:g(?:r(?:a(?:m)?)?)?)?)?)?)?$/);
  if (tail) {
    const before = out.slice(0, tail.index + tail[1].length);
    if ((before.match(/```/g) || []).length % 2 === 0) out = before;
  }
  return out;
}

/** Text the user should see: no diagram JSON, no References block. */
export const cleanAnswer = (text) => stripReferences(stripDiagram(text));

/** Inline: `code` (node ids become chips), **bold**. */
function Inline({ text, nodeIds, onNode }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i} className="font-semibold text-cg-text">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const inner = part.slice(1, -1);
      if (nodeIds.has(inner)) {
        return (
          <button
            key={i}
            type="button"
            title={`Show ${inner} in the graph`}
            onClick={() => onNode(inner)}
            className={cn(
              'mx-0.5 inline rounded border border-cg-border-strong bg-cg-canvas px-1 font-cg-mono text-cg-xs text-cg-text',
              'transition-colors duration-cg-fast ease-cg hover:bg-cg-hover',
              focusRing,
            )}
          >
            {inner.split('::').pop()}
          </button>
        );
      }
      return (
        <code key={i} className="mx-0.5 rounded bg-cg-overlay px-1 font-cg-mono text-cg-xs text-cg-text">
          {inner}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/**
 * Minimal Markdown for chat answers: fenced code, headings, bullet/numbered
 * lists, paragraphs, inline code and bold. Node ids in backticks are clickable.
 */
export default function ChatMarkdown({ text, nodeIds, onNode }) {
  const blocks = [];
  const lines = cleanAnswer(text).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i += 1;
      blocks.push(
        <pre key={blocks.length} className="overflow-x-auto rounded-cg-control border border-cg-border bg-cg-overlay p-3 font-cg-mono text-cg-xs leading-5 text-cg-text">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const list = line.match(/^\s*([-*]|\d+\.)\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={blocks.length} className={cn('flex flex-col gap-1 pl-5', ordered ? 'list-decimal' : 'list-disc', 'marker:text-cg-tertiary')}>
          {items.map((item, k) => (
            <li key={k}>
              <Inline text={item} nodeIds={nodeIds} onNode={onNode} />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={blocks.length} className="font-semibold text-cg-text">
          <Inline text={heading[1]} nodeIds={nodeIds} onNode={onNode} />
        </p>,
      );
      i += 1;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+|^#{1,6}\s|^\s*```/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={blocks.length}>
        <Inline text={para.join(' ')} nodeIds={nodeIds} onNode={onNode} />
      </p>,
    );
  }
  return <div className="flex flex-col gap-3">{blocks}</div>;
}
