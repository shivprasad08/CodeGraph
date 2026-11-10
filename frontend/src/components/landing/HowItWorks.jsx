import Reveal from './Reveal';

// Artefacts are real: the snippet is CodeGraph's own backend/enrichment.py, the node
// card and the Q&A come from the shivprasad08/mini_redis analysis at commit 29dfbc21.

const CODE = [
  ['kw', 'def ', 'name', '_node_degrees', 'plain', '(edges):'],
  ['plain', '    degrees = Counter()'],
  ['kw', '    for ', 'plain', 'edge ', 'kw', 'in ', 'plain', 'edges:'],
  ['plain', '        degrees[edge["source"]] += 1'],
  ['plain', '        degrees[edge["target"]] += 1'],
  ['kw', '    return ', 'plain', 'degrees'],
];

const TONE = { kw: 'text-cg-tertiary', name: 'text-cg-text font-medium', plain: 'text-cg-secondary' };

function CodeArtefact() {
  return (
    <pre className="overflow-x-auto py-3 font-cg-mono text-cg-xs leading-5" aria-label="Six lines of Python with one function definition">
      <code>
        {CODE.map((parts, line) => (
          <span
            key={line}
            className={
              line === 0
                ? 'block border-l-2 border-cg-text bg-cg-hover pl-[10px] pr-3'
                : 'block border-l-2 border-transparent pl-[10px] pr-3'
            }
          >
            <span aria-hidden="true" className="mr-3 inline-block w-3 text-right text-cg-tertiary">
              {line + 1}
            </span>
            {Array.from({ length: parts.length / 2 }, (_, i) => (
              <span key={i} className={TONE[parts[i * 2]]}>
                {parts[i * 2 + 1]}
              </span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  );
}

function NodeArtefact() {
  return (
    <div className="p-4">
      <p className="font-cg-mono text-cg-sm font-medium text-cg-text">start</p>
      <p className="mt-1 flex items-center gap-1.5 text-cg-xs text-cg-secondary">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-cg-node-function" />
        Function
      </p>
      <p className="mt-1 truncate font-cg-mono text-cg-xs text-cg-tertiary">src/miniredis/node.py</p>
      <p className="mt-3 text-cg-xs text-cg-secondary">
        <span className="font-cg-mono text-cg-text">9</span> callers · <span className="font-cg-mono text-cg-text">27</span> callees
      </p>
    </div>
  );
}

function AskArtefact() {
  return (
    <div className="flex flex-col gap-3 p-4 text-cg-xs">
      <p className="self-end rounded-cg-control bg-cg-hover px-3 py-2 text-cg-text">
        Where does a node start up, and what does it start?
      </p>
      {/* Quoted verbatim (first and last sentence) from the chat answer */}
      <p className="text-cg-secondary">
        A Mini-Redis node is started by calling the{' '}
        <code className="rounded border border-cg-border-strong px-1 font-cg-mono text-cg-text">start</code> method on the{' '}
        <code className="font-cg-mono text-cg-text">Node</code> class. … In short, a node boots up by invoking{' '}
        <code className="font-cg-mono text-cg-text">Node.start</code>, which constructs all internal subsystems and then
        runs the network server and supporting background tasks.
      </p>
      <p className="truncate font-cg-mono text-cg-tertiary">src/miniredis/node.py::start</p>
    </div>
  );
}

const STEPS = [
  {
    title: 'Parse',
    body: 'Every source file is parsed into an AST with tree-sitter.',
    artefact: <CodeArtefact />,
  },
  {
    title: 'Map',
    body: 'Functions, classes, calls and imports become a graph.',
    artefact: <NodeArtefact />,
  },
  {
    title: 'Ask',
    body: 'Chat with the codebase; answers link back to the graph.',
    artefact: <AskArtefact />,
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="mx-auto w-full max-w-[1120px] scroll-mt-20 px-4 sm:px-6">
      <Reveal>
        <h2 id="how-title" className="text-cg-2xl font-semibold text-cg-text">
          How it works
        </h2>
        <ol className="mt-10 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-6">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex min-w-0 flex-col">
              <p className="font-cg-mono text-cg-sm text-cg-tertiary">{String(i + 1).padStart(2, '0')}</p>
              <h3 className="mt-2 text-cg-lg font-semibold text-cg-text">{step.title}</h3>
              <p className="mt-1 text-cg-base text-cg-secondary">{step.body}</p>
              <div className="mt-5 flex-1 overflow-hidden rounded-cg-panel border border-cg-border bg-cg-raised shadow-cg-edge">
                {step.artefact}
              </div>
            </li>
          ))}
        </ol>
      </Reveal>
    </section>
  );
}
