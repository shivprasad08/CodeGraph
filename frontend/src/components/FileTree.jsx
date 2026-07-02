import { useState, useMemo, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildFileTree(graph) {
  const tree = {};
  if (!graph || !graph.nodes) return tree;

  const fileNodes = graph.nodes.filter(n => n.type === "file");
  
  for (const fileNode of fileNodes) {
    const parts = fileNode.path?.split("/") ?? fileNode.id.split("/");
    let current = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = {
          __type: "file",
          __node: fileNode,
          __path: fileNode.id,
          __functionCount: graph.nodes.filter(
            n => n.file === fileNode.id && n.type === "function"
          ).length,
          __classCount: graph.nodes.filter(
            n => n.file === fileNode.id && n.type === "class"
          ).length,
        };
      } else {
        if (!current[part]) {
          current[part] = { __type: "dir" };
        }
        current = current[part];
      }
    }
  }
  return tree;
}

// ---------------------------------------------------------------------------
// TreeNode Component
// ---------------------------------------------------------------------------
function TreeNode({ 
  name, 
  node, 
  depth, 
  allGraphNodes, 
  onFileSelect, 
  onNodeSelect, 
  selectedFilePath, 
  selectedNodeId, 
  searchQuery, 
  forceExpanded,
  treeKey 
}) {
  const [isOpen, setIsOpen] = useState(depth < 2);

  // Reset open state when treeKey changes (Collapse All)
  useEffect(() => {
    setIsOpen(depth < 2);
  }, [treeKey, depth]);

  const isDir = node.__type === "dir";
  const isFile = node.__type === "file";
  const isSelected = isFile && selectedFilePath === node.__path;

  // Filter out internal metadata keys
  const childrenKeys = isDir ? Object.keys(node).filter(k => k !== "__type").sort((a, b) => {
    const isDirA = node[a].__type === "dir";
    const isDirB = node[b].__type === "dir";
    if (isDirA && !isDirB) return -1;
    if (!isDirA && isDirB) return 1;
    return a.localeCompare(b);
  }) : [];

  if (isDir) {
    // If search is active, we rely on the parent (FileTree) having filtered the tree.
    // So if this directory was kept in the tree, we render it.
    const isEffectivelyOpen = isOpen || forceExpanded;

    return (
      <div>
        <div 
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className="flex items-center gap-1.5 h-8 cursor-pointer select-none hover:bg-surface-hover transition-colors group"
          onClick={() => setIsOpen(v => !v)}
          title={name}
        >
          <span className={`text-muted text-xs transition-transform duration-150 ${isEffectivelyOpen ? 'rotate-90' : 'rotate-0'}`}>
            ▶
          </span>
          <span className="text-xs">{isEffectivelyOpen ? "📂" : "📁"}</span>
          <span className="font-mono text-xs text-white/70 group-hover:text-white truncate">
            {name}
          </span>
          {!isEffectivelyOpen && (
            <span className="text-xs text-muted ml-auto mr-2">
              {/* simple heuristic, exact nested count requires recursive sum, we just show folder indicator */}
            </span>
          )}
        </div>
        
        {isEffectivelyOpen && childrenKeys.map(key => (
          <TreeNode 
            key={key} 
            name={key} 
            node={node[key]} 
            depth={depth + 1}
            allGraphNodes={allGraphNodes}
            onFileSelect={onFileSelect}
            onNodeSelect={onNodeSelect}
            selectedFilePath={selectedFilePath}
            selectedNodeId={selectedNodeId}
            searchQuery={searchQuery}
            forceExpanded={forceExpanded}
            treeKey={treeKey}
          />
        ))}
      </div>
    );
  }

  // File rendering
  return (
    <div>
      <div 
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex items-center gap-1.5 h-7 cursor-pointer select-none transition-colors group relative ${isSelected ? "bg-accent/15 border-l-2 border-accent" : "hover:bg-surface-hover border-l-2 border-transparent"}`}
        onClick={() => onFileSelect(node.__path)}
        title={node.__path}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0 bg-node-file" />
        
        {searchQuery ? (
          <span className={`font-mono text-xs truncate ${isSelected ? "text-white" : "text-white/60 group-hover:text-white/90"}`}>
            {name.split(new RegExp(`(${searchQuery})`, 'gi')).map((part, i) => 
              part.toLowerCase() === searchQuery.toLowerCase() 
                ? <span key={i} className="text-accent bg-accent/10">{part}</span> 
                : part
            )}
          </span>
        ) : (
          <span className={`font-mono text-xs truncate ${isSelected ? "text-white" : "text-white/60 group-hover:text-white/90"}`}>
            {name}
          </span>
        )}

        <div className={`ml-auto flex items-center gap-1 mr-2 transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          {node.__functionCount > 0 && <span className="text-[10px] text-node-function font-mono bg-node-function/10 px-1 rounded">{node.__functionCount}f</span>}
          {node.__classCount > 0 && <span className="text-[10px] text-node-class font-mono bg-node-class/10 px-1 rounded">{node.__classCount}c</span>}
        </div>

        {isSelected && (
          <span className="text-[10px] text-muted mr-2">▼</span>
        )}
      </div>

      {/* Sub-list of functions and classes when file is selected */}
      {isSelected && (() => {
        const childNodes = allGraphNodes.filter(
          n => n.file === node.__path && (n.type === "function" || n.type === "class")
        ).sort((a, b) => (a.lines?.[0] || 0) - (b.lines?.[0] || 0));

        return childNodes.map(childNode => {
          const isChildSelected = selectedNodeId === childNode.id;
          const isClass = childNode.type === "class";
          
          return (
            <div 
              key={childNode.id}
              style={{ paddingLeft: `${depth * 12 + 24}px` }}
              className={`flex items-center gap-1.5 h-6 cursor-pointer select-none transition-colors group border-l border-accent/20 ${isChildSelected ? "bg-accent/10" : "hover:bg-surface/50"}`}
              onClick={(e) => { e.stopPropagation(); onNodeSelect(childNode); }}
              title={childNode.id}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isClass ? "bg-node-class" : "bg-node-function"}`} />
              <span className={`font-mono text-[11px] truncate ${isChildSelected ? "text-accent" : "text-white/50 group-hover:text-white/80"}`}>
                {childNode.label || childNode.id.split('::').pop()}
              </span>
              {childNode.lines?.[0] && (
                <span className="text-[10px] text-muted font-mono ml-auto mr-2">
                  :{childNode.lines[0]}
                </span>
              )}
            </div>
          );
        });
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FileTree Component
// ---------------------------------------------------------------------------
export default function FileTree({ 
  graph, 
  onFileSelect, 
  onNodeSelect, 
  selectedFilePath, 
  selectedNodeId,
  hidden
}) {
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [isResizing, setIsResizing] = useState(false);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [treeKey, setTreeKey] = useState(0);

  // Resize handler
  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e) => {
      setSidebarWidth(Math.min(Math.max(e.clientX, 180), 450));
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // Handle global search shortcut if sidebar is hidden
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (!hidden) {
          e.preventDefault();
          setSearchVisible(true);
          // Wait for render then focus
          setTimeout(() => document.getElementById("file-tree-search")?.focus(), 50);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hidden]);

  const handleCollapseAll = () => {
    setTreeKey(k => k + 1); // Reset all TreeNode states
  };

  // Build full tree
  const fullTree = useMemo(() => buildFileTree(graph), [graph]);

  // Filter tree based on search
  const filteredTree = useMemo(() => {
    if (!searchQuery) return fullTree;
    const query = searchQuery.toLowerCase();
    
    // Recursive filter
    const filterNode = (node) => {
      if (node.__type === "file") {
        return node.__path.toLowerCase().includes(query) ? node : null;
      }
      
      const result = { __type: "dir" };
      let hasMatch = false;
      
      for (const [key, value] of Object.entries(node)) {
        if (key === "__type") continue;
        const filteredChild = filterNode(value);
        if (filteredChild) {
          result[key] = filteredChild;
          hasMatch = true;
        }
      }
      
      return hasMatch ? result : null;
    };
    
    const res = {};
    for (const [key, value] of Object.entries(fullTree)) {
      if (key === "__type") continue;
      const filtered = filterNode(value);
      if (filtered) res[key] = filtered;
    }
    return res;
  }, [fullTree, searchQuery]);

  const fileNodes = graph?.nodes?.filter(n => n.type === "file") || [];
  const fnNodes = graph?.nodes?.filter(n => n.type === "function") || [];
  const classNodes = graph?.nodes?.filter(n => n.type === "class") || [];

  return (
    <div 
      style={{ width: `${sidebarWidth}px` }} 
      className={`relative flex-shrink-0 h-full bg-bg border-r border-border flex flex-col ${hidden ? 'hidden' : ''}`}
    >
      {/* Header */}
      <div className="h-12 flex-shrink-0 bg-surface border-b border-border px-3 flex items-center justify-between">
        <span className="text-[10px] font-mono text-muted uppercase tracking-widest select-none">
          Files
        </span>
        <div className="flex items-center gap-1">
          <button 
            onClick={handleCollapseAll}
            className="w-6 h-6 flex items-center justify-center text-muted hover:text-white rounded hover:bg-surface-hover transition-colors text-xs"
            title="Collapse All"
          >
            ⊟
          </button>
          <button 
            onClick={() => {
              setSearchVisible(!searchVisible);
              if (!searchVisible) {
                setTimeout(() => document.getElementById("file-tree-search")?.focus(), 50);
              }
            }}
            className={`w-6 h-6 flex items-center justify-center rounded hover:bg-surface-hover transition-colors text-xs ${searchVisible ? "text-accent bg-accent/10" : "text-muted hover:text-white"}`}
            title="Search Files (Cmd/Ctrl + F)"
          >
            ⌕
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className={`overflow-hidden transition-all duration-200 flex-shrink-0 ${searchVisible ? 'max-h-10 border-b border-border' : 'max-h-0 border-transparent'}`}>
        <input
          id="file-tree-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter files..."
          className="w-full h-9 bg-surface px-3 py-2 font-mono text-xs text-white placeholder:text-muted focus:outline-none focus:bg-surface-hover"
          autoComplete="off"
          spellCheck="false"
        />
      </div>

      {/* Tree Body */}
      <div className="flex-1 overflow-y-auto py-2">
        {Object.keys(filteredTree).length === 0 ? (
          <div className="px-4 py-8 text-center text-muted text-xs font-mono">
            {searchQuery ? "No matching files found." : "No files available."}
          </div>
        ) : (
          Object.keys(filteredTree).sort((a, b) => {
            const isDirA = filteredTree[a].__type === "dir";
            const isDirB = filteredTree[b].__type === "dir";
            if (isDirA && !isDirB) return -1;
            if (!isDirA && isDirB) return 1;
            return a.localeCompare(b);
          }).map(key => (
            <TreeNode 
              key={key} 
              name={key} 
              node={filteredTree[key]} 
              depth={0} 
              allGraphNodes={graph.nodes}
              onFileSelect={onFileSelect}
              onNodeSelect={onNodeSelect}
              selectedFilePath={selectedFilePath}
              selectedNodeId={selectedNodeId}
              searchQuery={searchQuery}
              forceExpanded={searchQuery.length > 0}
              treeKey={treeKey}
            />
          ))
        )}
      </div>

      {/* Footer Stats */}
      <div className="h-8 flex-shrink-0 bg-surface border-t border-border px-3 flex items-center justify-between select-none">
        <span className="text-[10px] font-mono text-muted">
          {fileNodes.length} files · {fnNodes.length}f · {classNodes.length}c
        </span>
      </div>

      {/* Resize Handle */}
      <div 
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
        onMouseDown={() => setIsResizing(true)}
      />
    </div>
  );
}
