import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Copy, Download, MessageSquare, RotateCcw, Square } from 'lucide-react';
import { API_ERROR, streamChatMessage, fetchChatSuggestions } from '../api';
import { cn } from '../lib/cn';
import { Button, IconButton, focusRing } from '../ui';
import ChatMarkdown, { cleanAnswer } from './app/ChatMarkdown';
import { InlineError, RecoveryNotice } from './app/RecoveryStatus';
import { ArchitectureCard, FlowCard, ReferenceChips } from './app/ChatDiagrams';
import { isArchitectureQuestion } from '../lib/architecture';

const MESSAGE_LIMIT = 20;

/**
 * Chat tab. User messages are overlay bubbles; answers are plain full-width text
 * with Markdown, and node references select + zoom the node.
 * In offline (/demo) mode it shows an empty state instead.
 */
export default function ChatSidebar({
  graph,
  offline = false,
  onNodeSelect,
  onNodeHighlight,
  onAnalyzeOwn,
  onRerun,
  onReloadGraph,
  dirColorMap,
  onDiagramNodeClick,
}) {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isWaiting, setIsWaiting] = useState(false); // sent, no token yet
  const [isStreaming, setIsStreaming] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [messageCount, setMessageCount] = useState(0);
  // Server cache was wiped: reloading the analysis, and whether the commit moved on
  const [recovering, setRecovering] = useState(false);
  const [changedJobId, setChangedJobId] = useState(null);

  const endRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const nodeIds = useMemo(() => new Set((graph?.nodes ?? []).map((n) => n.id)), [graph]);
  const busy = isWaiting || isStreaming;

  useEffect(() => {
    if (offline || !graph?.repo || !graph?.commit_sha) return;
    fetchChatSuggestions(graph.repo, graph.commit_sha).then(setSuggestions);
  }, [offline, graph?.repo, graph?.commit_sha]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => () => abortRef.current?.(), []);

  const selectNodeById = (id) => {
    const node = graph?.nodes?.find((n) => n.id === id);
    if (node) onNodeSelect(node);
  };

  const updateLast = (fn) =>
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') next[next.length - 1] = fn(last);
      return next;
    });

  const sendMessage = (text) => {
    if (!text.trim() || busy || messageCount >= MESSAGE_LIMIT) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-u`, role: 'user', content: text },
      // Architecture questions get a diagram computed from the graph (no extra LLM call)
      { id: `${Date.now()}-a`, role: 'assistant', content: '', nodes: [], archCard: isArchitectureQuestion(text), diagram: null },
    ]);
    setInputValue('');
    setIsWaiting(true);
    setMessageCount((c) => c + 1);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    abortRef.current = streamChatMessage(
      graph?.repo,
      graph?.commit_sha,
      text,
      history,
      (token) => {
        setIsWaiting(false);
        setIsStreaming(true);
        updateLast((m) => ({ ...m, content: m.content + token }));
      },
      (refs, extra) => {
        setIsWaiting(false);
        setIsStreaming(false);
        abortRef.current = null;
        updateLast((m) => ({ ...m, nodes: refs, diagram: extra?.diagram ?? null, content: m.content || 'Stopped.' }));
        if (refs.length) onNodeHighlight?.(refs);
      },
      (message, apiError) => {
        setIsWaiting(false);
        setIsStreaming(false);
        setRecovering(false);
        abortRef.current = null;
        updateLast((m) => ({ ...m, error: true, errorCode: apiError?.code, content: message }));
      },
      {
        onRecovering: () => setRecovering(true),
        onRecovered: ({ changed, jobId }) => {
          setRecovering(false);
          if (changed) setChangedJobId(jobId);
        },
      },
    );
  };

  const stop = () => abortRef.current?.();

  const clearConversation = () => {
    stop();
    setMessages([]);
    setMessageCount(0);
    onNodeHighlight?.([]);
  };

  const downloadConversation = () => {
    const text = messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n---\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `codegraph-chat-${graph?.repo?.replace('/', '-') || 'export'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (offline) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
        <MessageSquare size={24} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
        <h2 className="mt-3 text-cg-base font-medium text-cg-text">Chat is available on your own analyses</h2>
        <p className="mt-1 max-w-[280px] text-cg-sm text-cg-secondary">
          Ask questions about a repository and get answers that link back to its graph.
        </p>
        <Button size="sm" variant="primary" className="mt-4" onClick={onAnalyzeOwn}>
          Analyze your own repo
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {messages.length > 0 && (
        <div className="flex h-9 shrink-0 items-center justify-end gap-0.5 border-b border-cg-border px-1.5">
          <IconButton label="Download conversation" size="sm" onClick={downloadConversation}>
            <Download size={16} strokeWidth={1.5} aria-hidden="true" />
          </IconButton>
          <IconButton label="Clear conversation" size="sm" onClick={clearConversation}>
            <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
          </IconButton>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={busy}>
        {changedJobId && (
          <RecoveryNotice className="mb-4" onReloadGraph={onReloadGraph ? () => onReloadGraph(changedJobId) : undefined} />
        )}
        {messages.length === 0 ? (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-cg-base font-medium text-cg-text">Ask about this codebase</h2>
              <p className="mt-1 text-cg-sm text-cg-secondary">
                Answers use the structure of {graph?.repo || 'this repository'} and link to the nodes they mention.
              </p>
            </div>
            {suggestions.length > 0 && (
              <ul className="flex flex-col items-start gap-1">
                {suggestions.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => sendMessage(s)}
                      className={cn(
                        'rounded text-left text-cg-sm text-cg-secondary underline decoration-cg-border-strong underline-offset-4',
                        'transition-colors duration-cg-fast ease-cg hover:text-cg-text hover:decoration-cg-text [@media(pointer:coarse)]:min-h-11',
                        focusRing,
                      )}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {messages.map((m, idx) =>
              m.role === 'user' ? (
                <p key={m.id} className="ml-8 self-end whitespace-pre-wrap rounded-cg-panel bg-cg-overlay px-3 py-2 text-cg-sm text-cg-text">
                  {m.content}
                </p>
              ) : (
                <div key={m.id} className="group text-cg-sm text-cg-secondary">
                  {m.content === '' && isWaiting && idx === messages.length - 1 ? (
                    <p className="text-cg-tertiary">{recovering ? 'Reloading this analysis on the server…' : 'Thinking…'}</p>
                  ) : m.error ? (
                    <InlineError message={m.content} onRerun={m.errorCode === API_ERROR.CACHE_MISS ? onRerun : undefined} />
                  ) : (
                    <ChatMarkdown text={m.content} nodeIds={nodeIds} onNode={selectNodeById} />
                  )}
                  {!m.error && !(isStreaming && idx === messages.length - 1) && m.content && (
                    <>
                      {m.diagram?.nodes?.length >= 2 && (
                        <FlowCard diagram={m.diagram} graph={graph} dirColorMap={dirColorMap} onNodeClick={onDiagramNodeClick} />
                      )}
                      {m.archCard && <ArchitectureCard graph={graph} dirColorMap={dirColorMap} onNodeClick={onDiagramNodeClick} />}
                    </>
                  )}
                  <ReferenceChips ids={m.nodes ?? []} onSelect={selectNodeById} />
                  {m.content && !m.error && !(isStreaming && idx === messages.length - 1) && (
                    <IconButton
                      label="Copy answer"
                      size="sm"
                      className="mt-1 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
                      onClick={() => navigator.clipboard?.writeText(cleanAnswer(m.content))}
                    >
                      <Copy size={14} strokeWidth={1.5} aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              ),
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="shrink-0 border-t border-cg-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage(inputValue);
        }}
      >
        {messageCount > 15 && (
          <p className="mb-2 text-cg-xs text-cg-tertiary">{Math.max(0, MESSAGE_LIMIT - messageCount)} messages left this hour</p>
        )}
        <div className="flex items-end gap-2 rounded-cg-control border border-cg-border-strong bg-cg-canvas p-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-cg-focus">
          <label htmlFor="chat-input" className="sr-only">
            Ask about this codebase
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            value={inputValue}
            rows={1}
            placeholder="Ask about this codebase"
            disabled={messageCount >= MESSAGE_LIMIT}
            onChange={(e) => {
              setInputValue(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(inputValue);
              }
            }}
            className="max-h-[120px] min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-cg-sm text-cg-text outline-none placeholder:text-cg-tertiary disabled:cursor-not-allowed [@media(pointer:coarse)]:text-[16px]"
          />
          {busy ? (
            <IconButton label="Stop" size="sm" variant="secondary" onClick={stop} type="button">
              <Square size={14} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton label="Send" shortcut="Enter" size="sm" variant="secondary" type="submit" disabled={!inputValue.trim() || messageCount >= MESSAGE_LIMIT}>
              <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <p className="mt-1.5 text-cg-xs text-cg-tertiary">Enter to send · Shift+Enter for a new line</p>
      </form>
    </div>
  );
}
