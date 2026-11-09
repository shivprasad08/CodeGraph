// Page pattern: documentation / component catalog.
// Dev-only reference for the design-system tokens and base components (route /dev/ui).
import { useState } from 'react';
import { ArrowRight, Copy, Maximize2, Play, Search, Settings, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Divider,
  IconButton,
  Input,
  Kbd,
  Panel,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '../ui';

// Static stand-in for keyboard focus, so the ring is visible without tabbing
const FOCUS_DEMO = 'outline outline-2 outline-offset-2 outline-cg-focus';

const SECTIONS = [
  ['surfaces', 'Surfaces'],
  ['text', 'Text'],
  ['data', 'Data palette'],
  ['type', 'Type scale'],
  ['buttons', 'Button'],
  ['icon-buttons', 'IconButton'],
  ['inputs', 'Input'],
  ['tabs', 'Tabs'],
  ['panel', 'Panel'],
  ['badges', 'Badge'],
  ['kbd', 'Kbd, Spinner, Divider'],
  ['overlays', 'Tooltip and Dialog'],
];

const SURFACES = [
  ['--cg-canvas', 'bg-cg-canvas', 'Canvas (L0)'],
  ['--cg-raised', 'bg-cg-raised', 'Raised (L1)'],
  ['--cg-overlay', 'bg-cg-overlay', 'Overlay (L2)'],
  ['--cg-hover', 'bg-cg-hover', 'Hover (L3)'],
];

const TEXT = [
  ['--cg-text', 'text-cg-text', 'Primary text'],
  ['--cg-text-secondary', 'text-cg-secondary', 'Secondary text'],
  ['--cg-text-tertiary', 'text-cg-tertiary', 'Tertiary text'],
];

const DATA = [
  ['--cg-node-file', 'bg-cg-node-file', 'File node'],
  ['--cg-node-function', 'bg-cg-node-function', 'Function node'],
  ['--cg-node-class', 'bg-cg-node-class', 'Class node'],
  ['--cg-node-entry', 'bg-cg-node-entry', 'Entry point'],
  ['--cg-sev-high', 'bg-cg-sev-high', 'Severity: high'],
  ['--cg-sev-med', 'bg-cg-sev-med', 'Severity: medium'],
  ['--cg-sev-low', 'bg-cg-sev-low', 'Severity: low'],
  ['--cg-success', 'bg-cg-success', 'Success'],
];

const TYPE_SCALE = [
  ['text-cg-display', 'Display', '48/52, 600, −0.02em'],
  ['text-cg-2xl', 'Heading 2xl', '28/34, −0.01em'],
  ['text-cg-xl', 'Heading xl', '20/28'],
  ['text-cg-lg', 'Large', '17/26'],
  ['text-cg-base', 'Base prose', '15/24'],
  ['text-cg-sm', 'App body', '13/20'],
  ['text-cg-xs', 'Caption', '12/16'],
];

function Section({ id, title, description, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 border-t border-cg-border py-10">
      <h2 id={`${id}-title`} className="text-cg-xl font-semibold text-cg-text">
        {title}
      </h2>
      {description && <p className="mt-1 max-w-prose text-cg-sm text-cg-secondary">{description}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** A labelled cell in a component grid. */
function Specimen({ caption, children }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <div className="flex min-h-11 flex-wrap items-center gap-3">{children}</div>
      <p className="text-cg-xs text-cg-tertiary">{caption}</p>
    </div>
  );
}

function Swatch({ token, className, label, textClass }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className={`flex h-16 items-end rounded-cg-control border border-cg-border p-2 ${className}`}
        aria-hidden="true"
      >
        {textClass && <span className={`text-cg-sm ${textClass}`}>Aa</span>}
      </div>
      <div className="min-w-0">
        <p className="text-cg-sm text-cg-text">{label}</p>
        <p className="truncate font-cg-mono text-cg-xs text-cg-tertiary">{token}</p>
      </div>
    </div>
  );
}

export default function StyleGuideView() {
  const [chips, setChips] = useState({ high: true, med: false, low: false });
  const toggle = (key) => setChips((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="min-h-full flex-1 bg-cg-canvas font-cg-sans text-cg-text">
      <div className="mx-auto w-full max-w-5xl px-4 pb-24 pt-10 sm:px-6">
        <header className="pb-8">
          <h1 className="text-cg-2xl font-semibold">Design system</h1>
          <p className="mt-2 max-w-prose text-cg-base text-cg-secondary">
            Tokens and base components for CodeGraph. Chrome is monochrome; colour is used only for data.
            Development only.
          </p>
          <nav aria-label="On this page" className="mt-6">
            <ul className="flex flex-wrap gap-x-4 gap-y-2 text-cg-sm">
              {SECTIONS.map(([id, label]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="inline-flex rounded text-cg-secondary underline-offset-4 hover:text-cg-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cg-focus [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <Section id="surfaces" title="Surfaces" description="Separated by 1px hairlines and one-step lightness shifts. No glow, no drop shadows.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SURFACES.map(([token, cls, label]) => (
              <Swatch key={token} token={token} className={cls} label={label} />
            ))}
          </div>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-cg-control border border-cg-border p-4 text-cg-sm text-cg-secondary">
              <span className="font-cg-mono text-cg-xs text-cg-tertiary">--cg-border</span>
              <p className="mt-1">Decorative hairline for panels and dividers.</p>
            </div>
            <div className="rounded-cg-control border border-cg-border-strong p-4 text-cg-sm text-cg-secondary">
              <span className="font-cg-mono text-cg-xs text-cg-tertiary">--cg-border-strong</span>
              <p className="mt-1">Control outlines (inputs, secondary buttons). At least 3:1 on every surface.</p>
            </div>
          </div>
        </Section>

        <Section id="text" title="Text" description="All three levels meet 4.5:1 on canvas, raised and overlay.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {SURFACES.slice(0, 3).map(([token, cls, label]) => (
              <div key={token} className={`rounded-cg-control border border-cg-border p-4 ${cls}`}>
                <p className="font-cg-mono text-cg-xs text-cg-tertiary">{label}</p>
                {TEXT.map(([t, textCls, textLabel]) => (
                  <p key={t} className={`mt-2 text-cg-sm ${textCls}`}>
                    {textLabel}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section id="data" title="Data palette" description="Colour appears only for graph node types and health severity, never for chrome.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {DATA.map(([token, cls, label]) => (
              <Swatch key={token} token={token} className={cls} label={label} />
            ))}
          </div>
        </Section>

        <Section id="type" title="Type scale" description="Geist for UI and prose; Geist Mono for code, file paths and repo names. Weights 400, 500 and 600.">
          <div className="flex flex-col divide-y divide-cg-border">
            {TYPE_SCALE.map(([cls, label, spec]) => (
              <div key={cls} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:gap-6">
                <p className="w-40 shrink-0 font-cg-mono text-cg-xs text-cg-tertiary">
                  {cls}
                  <br />
                  {spec}
                </p>
                <p className={`${cls} min-w-0 break-words`}>{label}</p>
              </div>
            ))}
            <div className="flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:gap-6">
              <p className="w-40 shrink-0 font-cg-mono text-cg-xs text-cg-tertiary">font-cg-mono</p>
              <p className="min-w-0 break-all font-cg-mono text-cg-sm">backend/enrichment.py::enrich_graph</p>
            </div>
          </div>
        </Section>

        <Section id="buttons" title="Button" description="Verb-first labels. Heights 32, 36 and 44px; at least 44px on touch. Hover changes background only.">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <Specimen caption="Variants: primary, secondary, ghost, danger">
              <Button variant="primary">Analyze repo</Button>
              <Button variant="secondary">Re-run analysis</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="danger">Delete cache</Button>
            </Specimen>
            <Specimen caption="Sizes: sm 32px, md 36px, lg 44px">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg" variant="primary">Large</Button>
            </Specimen>
            <Specimen caption="Leading and trailing icons">
              <Button variant="primary" leadingIcon={<Play size={16} strokeWidth={1.5} aria-hidden="true" />}>
                Analyze repo
              </Button>
              <Button trailingIcon={<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />}>Open graph</Button>
            </Specimen>
            <Specimen caption="Focus (keyboard only; shown statically here)">
              <Button variant="primary" className={FOCUS_DEMO}>Analyze repo</Button>
              <Button className={FOCUS_DEMO}>Re-run analysis</Button>
            </Specimen>
            <Specimen caption="Loading: spinner, same width, aria-busy, clicks blocked">
              <Button variant="primary" loading>Analyze repo</Button>
              <Button loading>Re-run analysis</Button>
            </Specimen>
            <Specimen caption="Disabled">
              <Button variant="primary" disabled>Analyze repo</Button>
              <Button disabled>Re-run analysis</Button>
              <Button variant="danger" disabled>Delete cache</Button>
            </Specimen>
          </div>
        </Section>

        <Section id="icon-buttons" title="IconButton" description="Square, with a required label used for aria-label and the tooltip. Hover or focus to see the tooltip.">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <Specimen caption="Ghost, md 36px (20px icons in primary toolbars)">
              <IconButton label="Search" shortcut="/">
                <Search size={20} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
              <IconButton label="Fit graph to screen" shortcut="F">
                <Maximize2 size={20} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
              <IconButton label="Settings">
                <Settings size={20} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            </Specimen>
            <Specimen caption="Secondary, sm 32px">
              <IconButton label="Copy link" variant="secondary" size="sm">
                <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
              <IconButton label="Delete" variant="secondary" size="sm">
                <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            </Specimen>
            <Specimen caption="Focus (static) and disabled">
              <IconButton label="Search" className={FOCUS_DEMO}>
                <Search size={20} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
              <IconButton label="Search" disabled>
                <Search size={20} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            </Specimen>
          </div>
        </Section>

        <Section id="inputs" title="Input" description="Always labelled. Hint and error text are linked with aria-describedby. No decorative icons.">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <Input
              label="Repository"
              prefix="github.com/"
              placeholder="owner/repo"
              hint="Public Python repositories, up to 60 files."
            />
            <Input
              label="Repository"
              prefix="github.com/"
              defaultValue="psf/requests/tree"
              error="Enter a repository as owner/name, for example psf/requests."
            />
            <Input label="Search nodes" hint="Matches file, function and class names." suffix={<Kbd>/</Kbd>} />
            <Input label="Disabled" disabled defaultValue="Read only" />
          </div>
        </Section>

        <Section id="tabs" title="Tabs" description="Arrow keys move between tabs; Home and End jump to the ends. Active tab: text colour and a 2px underline.">
          <Tabs defaultValue="summary">
            <TabsList aria-label="Node details">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="impact">Impact</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                History
              </TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="text-cg-sm text-cg-secondary">
              Plain-English summary of the selected function.
            </TabsContent>
            <TabsContent value="source" className="text-cg-sm text-cg-secondary">
              Source code with syntax highlighting.
            </TabsContent>
            <TabsContent value="impact" className="text-cg-sm text-cg-secondary">
              Functions affected by a change to this one.
            </TabsContent>
          </Tabs>
        </Section>

        <Section id="panel" title="Panel" description="Raised surface, 1px hairline border, 12px radius, optional header with actions.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Panel
              title="enrich_graph"
              actions={
                <IconButton label="Copy node id" size="sm">
                  <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
                </IconButton>
              }
            >
              <p className="font-cg-mono text-cg-xs text-cg-tertiary">backend/enrichment.py</p>
              <p className="mt-2 text-cg-sm text-cg-secondary">
                Fills in summaries for the most-connected functions and classes in the graph.
              </p>
            </Panel>
            <Panel>
              <p className="text-cg-sm text-cg-secondary">Panel without a header.</p>
            </Panel>
          </div>
        </Section>

        <Section id="badges" title="Badge" description="Only for filter chips or meaningful status. Never decorative metadata.">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <Specimen caption="Filter chips (toggle; aria-pressed)">
              <Badge tone="high" selected={chips.high} onClick={() => toggle('high')}>
                High
              </Badge>
              <Badge tone="med" selected={chips.med} onClick={() => toggle('med')}>
                Medium
              </Badge>
              <Badge tone="low" selected={chips.low} onClick={() => toggle('low')}>
                Low
              </Badge>
            </Specimen>
            <Specimen caption="Status">
              <Badge tone="high">High severity</Badge>
              <Badge tone="entry">Entry point</Badge>
              <Badge tone="success">Analyzed</Badge>
            </Specimen>
          </div>
        </Section>

        <Section id="kbd" title="Kbd, Spinner, Divider">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
            <Specimen caption="Key caps">
              <Kbd>⌘K</Kbd>
              <Kbd>/</Kbd>
              <Kbd>Esc</Kbd>
              <span className="text-cg-sm text-cg-secondary">
                Press <Kbd>⌘K</Kbd> to search
              </span>
            </Specimen>
            <Specimen caption="Spinner (static under reduced motion)">
              <Spinner label="Loading graph" />
              <Spinner size={20} label="Loading graph" />
            </Specimen>
            <Specimen caption="Horizontal and vertical hairlines">
              <div className="flex h-8 w-full min-w-32 items-center gap-3">
                <Divider className="flex-1" />
                <Divider orientation="vertical" />
                <Divider className="flex-1" />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="overlays" title="Tooltip and Dialog" description="Tooltips open after 300ms on hover or focus. Dialogs trap focus, restore it on close, and close with Esc. No backdrop blur.">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <Specimen caption="Tooltip on a text button">
              <Tooltip content="Analysis takes about a minute on a cold start">
                <Button>Hover or focus me</Button>
              </Tooltip>
            </Specimen>
            <Specimen caption="Destructive actions always confirm">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="danger" leadingIcon={<Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />}>
                    Delete cached analysis
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title="Delete cached analysis?"
                  description="The graph for psf/requests will be removed. You can analyze the repository again at any time."
                  footer={
                    <>
                      <DialogClose asChild>
                        <Button variant="ghost">Cancel</Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button variant="danger">Delete analysis</Button>
                      </DialogClose>
                    </>
                  }
                />
              </Dialog>
            </Specimen>
          </div>
        </Section>
      </div>
    </div>
  );
}
