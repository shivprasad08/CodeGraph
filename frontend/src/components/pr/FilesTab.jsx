// Files: every file in the PR, its status and whether its lines were mapped to graph nodes.
import { cn } from '../../lib/cn';

const STATUS = { added: 'Added', modified: 'Modified', removed: 'Removed', renamed: 'Renamed', copied: 'Copied', changed: 'Changed' };

export default function FilesTab({ files, partial }) {
  const mapped = files.filter((f) => f.mapped);
  const rest = files.filter((f) => !f.mapped);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-cg-sm text-cg-secondary">
        {files.length} file{files.length === 1 ? '' : 's'} · {mapped.length} mapped to the code graph
        {partial && <span className="text-cg-sev-med"> · partial result: some files couldn&apos;t be mapped (see notes)</span>}
      </p>
      <ul className="flex flex-col divide-y divide-cg-border rounded-cg-control border border-cg-border">
        {[...mapped, ...rest].map((f) => (
          <li key={f.filename} className="flex items-start gap-3 px-3 py-2">
            <span className="w-16 shrink-0 text-cg-xs text-cg-secondary">{STATUS[f.status] ?? f.status}</span>
            <span className="min-w-0 flex-1">
              <span className="block break-all font-cg-mono text-cg-sm text-cg-text">
                {f.previous_filename && f.previous_filename !== f.filename && (
                  <span className="text-cg-tertiary">{f.previous_filename} → </span>
                )}
                {f.filename}
              </span>
              <span className={cn('block text-cg-xs', f.mapped ? 'text-cg-secondary' : 'text-cg-tertiary')}>
                {f.mapped
                  ? f.note || `Mapped · ${f.nodes} function${f.nodes === 1 ? '' : 's'} or class${f.nodes === 1 ? '' : 'es'} changed`
                  : f.note}
              </span>
            </span>
            <span className="shrink-0 font-cg-mono text-cg-xs">
              <span className="text-cg-success">+{f.additions}</span> <span className="text-cg-sev-high">−{f.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
