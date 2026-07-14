import { useState, useEffect, useRef } from 'react';
import { streamChatMessage, fetchChatSuggestions } from '../api';

export default function ChatSidebar({ graph, onNodeHighlight, onNodeClick }) {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [messageCount, setMessageCount] = useState(0);
  
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const tokenQueue = useRef([]);
  const drainInterval = useRef(null);

  // Fetch suggestions on mount
  useEffect(() => {
    if (graph?.repo && graph?.commit_sha) {
      fetchChatSuggestions(graph.repo, graph.commit_sha).then(setSuggestions);
    }
  }, [graph?.repo, graph?.commit_sha]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle typing animation stream
  useEffect(() => {
    if (isStreaming && !drainInterval.current) {
      drainInterval.current = setInterval(() => {
        if (tokenQueue.current.length > 0) {
          const token = tokenQueue.current.shift();
          setMessages(prev => {
            const newMsgs = [...prev];
            const last = newMsgs[newMsgs.length - 1];
            if (last && last.role === 'assistant') {
              last.content += token;
            }
            return newMsgs;
          });
        }
      }, 15);
    } else if (!isStreaming && drainInterval.current) {
      clearInterval(drainInterval.current);
      drainInterval.current = null;
      // Drain remaining tokens instantly
      if (tokenQueue.current.length > 0) {
        const remaining = tokenQueue.current.join("");
        tokenQueue.current = [];
        setMessages(prev => {
          const newMsgs = [...prev];
          const last = newMsgs[newMsgs.length - 1];
          if (last && last.role === 'assistant') {
            last.content += remaining;
          }
          return newMsgs;
        });
      }
    }
    return () => {
      if (drainInterval.current) clearInterval(drainInterval.current);
    };
  }, [isStreaming]);

  const sendMessage = (text) => {
    if (!text.trim() || isLoading) return;

    const userMsg = { id: Date.now(), role: "user", content: text, nodes: [], timestamp: new Date() };
    const assistantMsg = { id: Date.now() + 1, role: "assistant", content: "", nodes: [], timestamp: new Date() };
    
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInputValue("");
    setIsLoading(true);
    setMessageCount(c => c + 1);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'; // reset height
    }

    const history = messages.map(m => ({ role: m.role, content: m.content }));
    tokenQueue.current = [];

    streamChatMessage(
      graph?.repo,
      graph?.commit_sha,
      text,
      history,
      // onToken
      (token) => {
        setIsLoading(false);
        setIsStreaming(true);
        tokenQueue.current.push(token);
      },
      // onDone
      (nodeIds) => {
        setIsStreaming(false);
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, nodes: nodeIds } : m
        ));
        if (nodeIds.length > 0) {
          onNodeHighlight(nodeIds);
        }
      },
      // onError
      (error) => {
        setIsLoading(false);
        setIsStreaming(false);
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, content: error } : m
        ));
      }
    );
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputValue);
    }
  };

  const handleInput = (e) => {
    setInputValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  const clearConversation = () => {
    setMessages([]);
    setMessageCount(0);
    onNodeHighlight([]);
  };

  const downloadConversation = () => {
    const text = messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join("\n\n---\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codegraph-chat-${graph?.repo?.replace("/", "-") || "export"}.txt`;
    a.click();
  };

  // Render markdown-like text
  const renderMessageContent = (content) => {
    // Hide References section
    let displayContent = content.replace(/(?:\n|^)References:[\s\S]*/, '').trim();

    // Split by backticks and bold
    const parts = displayContent.split(/(`[^`]+`|\*\*[^*]+\*\*|\n)/g);
    
    return parts.map((part, i) => {
      if (part === '\n') {
        return <br key={i} />;
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1);
        // Check if it's a known node reference
        const isNodeRef = inner.includes("::") && graph?.nodes?.some(n => n.id === inner);
        
        if (isNodeRef) {
          const shortLabel = inner.split("::").pop();
          return (
            <span
              key={i}
              title={inner}
              onClick={() => {
                const node = graph?.nodes?.find(n => n.id === inner);
                if (node) onNodeClick(node);
              }}
              className="inline-flex items-center gap-1 bg-accent/15 border border-accent/30 rounded-full px-2 py-0.5 font-mono text-[10px] text-accent cursor-pointer hover:bg-accent/25 transition-colors mx-0.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              {shortLabel}
            </span>
          );
        }
        return (
          <code key={i} className="bg-accent/10 text-accent font-mono text-[10px] px-1 py-0.5 rounded border border-accent/20 mx-0.5">
            {inner}
          </code>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className="w-[300px] h-full bg-bg border-l border-border flex flex-col flex-shrink-0 relative z-20">
      
      {/* Header */}
      <div className="h-12 flex-shrink-0 bg-surface border-b border-border px-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-white">
          <span className="text-accent text-lg">✦</span>
          <span className="font-mono text-sm font-medium">Ask me anything</span>
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button onClick={downloadConversation} title="Download chat" className="text-muted hover:text-white transition w-6 h-6 flex items-center justify-center rounded hover:bg-surface-hover">
              ↓
            </button>
          )}
          <button onClick={clearConversation} title="Clear conversation" className="text-muted hover:text-white transition w-6 h-6 flex items-center justify-center rounded hover:bg-surface-hover">
            ⟳
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-2">
            <div className="text-4xl text-accent/60 mb-3">✦</div>
            <h3 className="text-sm font-mono text-white/70">Ask about this codebase</h3>
            <p className="text-xs text-muted mt-1 max-w-[200px]">
              I know every file, function, and relationship in {graph?.repo || "this repo"}.
            </p>
            
            {suggestions.length > 0 && (
              <div className="mt-8 w-full space-y-2">
                <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">Try asking:</div>
                {suggestions.map((sug, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(sug)}
                    className="w-full text-left bg-surface border border-border rounded-lg px-3 py-2.5 font-mono text-xs text-white/70 hover:text-white hover:border-accent/40 hover:bg-surface-hover transition-all"
                  >
                    {sug}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              
              {m.role === 'user' ? (
                <div className="max-w-[85%] bg-accent/20 border border-accent/30 rounded-2xl rounded-tr-sm px-3 py-2 font-sans text-sm text-white leading-relaxed whitespace-pre-wrap">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[90%] space-y-2 group relative">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-accent text-[10px]">✦</span>
                    <span className="text-[10px] font-mono text-muted uppercase">CodeGraph AI</span>
                  </div>
                  
                  {m.content === "" && isLoading && !isStreaming ? (
                    <div className="bg-surface border border-border rounded-2xl rounded-tl-sm px-4 py-3 flex gap-1 items-center">
                      <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  ) : (
                    <div className="bg-surface border border-border rounded-2xl rounded-tl-sm px-3 py-2.5 font-sans text-sm text-white/90 leading-relaxed">
                      {renderMessageContent(m.content)}
                      
                      {isStreaming && m.id === messages[messages.length - 1].id && (
                        <span className="inline-block w-2 h-3.5 bg-accent/80 animate-pulse ml-1 align-middle" />
                      )}
                      
                      <button 
                        onClick={() => navigator.clipboard.writeText(m.content.replace(/(?:\n|^)References:[\s\S]*/, '').trim())}
                        className="absolute top-6 right-2 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-muted hover:text-white bg-surface rounded transition"
                        title="Copy text"
                      >
                        ⎘
                      </button>
                    </div>
                  )}

                  {/* Referenced Nodes Chips */}
                  {m.nodes && m.nodes.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                      <span className="text-[10px] text-muted font-mono mr-1">Referenced:</span>
                      {m.nodes.map(nodeId => (
                        <span
                          key={nodeId}
                          onClick={() => {
                            const node = graph?.nodes?.find(n => n.id === nodeId);
                            if (node) onNodeClick(node);
                          }}
                          className="inline-flex items-center gap-1 bg-surface border border-border rounded-full px-2 py-0.5 font-mono text-[10px] text-white/80 cursor-pointer hover:border-accent/40 transition-colors"
                        >
                          <span className="w-1 h-1 rounded-full bg-accent/60" />
                          {nodeId.split("/").pop()}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} className="h-1" />
      </div>

      {/* Input Area */}
      <div className="bg-surface border-t border-border p-3">
        {messageCount > 15 && (
          <div className="text-[10px] font-mono text-amber-500 text-center mb-2">
            {20 - messageCount} messages remaining this hour
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this codebase..."
            rows={1}
            disabled={isLoading || messageCount >= 20}
            className="flex-1 bg-bg border border-border rounded-xl px-3 py-2.5 font-mono text-xs text-white placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 resize-none leading-relaxed transition-all duration-200 hide-scrollbar disabled:opacity-50"
            style={{ maxHeight: '120px' }}
          />
          <button
            onClick={() => sendMessage(inputValue)}
            disabled={!inputValue.trim() || isLoading || messageCount >= 20}
            className={`w-9 h-9 flex-shrink-0 rounded-xl flex items-center justify-center transition-colors ${
              inputValue.trim() && !isLoading && messageCount < 20
                ? 'bg-accent hover:bg-[#9061f9] text-white' 
                : 'bg-surface border border-border text-muted cursor-not-allowed'
            }`}
          >
            {isLoading ? (
              <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              "↑"
            )}
          </button>
        </div>
        <div className="text-[10px] text-muted text-center font-mono mt-2">
          Enter to send · Shift+Enter for newline
        </div>
      </div>
    </div>
  );
}
