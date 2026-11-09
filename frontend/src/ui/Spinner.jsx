import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Spinner — Lucide Loader2. Spins only when motion is allowed; static under
 * prefers-reduced-motion.
 * @param {object} props
 * @param {number} [props.size=16] Icon size in px.
 * @param {string} [props.label] Announced to screen readers (role="status"). Omit when
 *   the parent already communicates loading (e.g. a Button with aria-busy).
 * @param {string} [props.className]
 */
export default function Spinner({ size = 16, label, className }) {
  const icon = (
    <Loader2
      aria-hidden="true"
      size={size}
      strokeWidth={1.5}
      className={cn('shrink-0 motion-safe:animate-spin', className)}
    />
  );
  if (!label) return icon;
  return (
    <span role="status" className="inline-flex items-center">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
