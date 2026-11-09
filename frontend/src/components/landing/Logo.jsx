import { cn } from '../../lib/cn';

/** CodeGraph mark: three connected nodes, drawn in currentColor. Same shape as public/favicon.svg. */
export function LogoMark({ size = 20, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M5 15.5 10 4.5M10 4.5l5 8M5 15.5l10-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="4.5" r="2.5" fill="currentColor" />
      <circle cx="5" cy="15.5" r="2.5" fill="currentColor" />
      <circle cx="15" cy="12.5" r="2.5" fill="currentColor" />
    </svg>
  );
}

/** Mark + "CodeGraph" wordmark. */
export default function Logo({ className }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-cg-text', className)}>
      <LogoMark />
      <span className="font-cg-sans text-[15px] font-semibold leading-none">CodeGraph</span>
    </span>
  );
}
