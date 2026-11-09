import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';

/**
 * Tooltip — Radix tooltip on the overlay surface. Opens on hover and keyboard
 * focus after 300ms; Esc closes. Never put essential information only here.
 * @param {object} props
 * @param {import('react').ReactNode} props.content
 * @param {import('react').ReactElement} props.children The trigger (must accept a ref).
 * @param {'top'|'right'|'bottom'|'left'} [props.side='top']
 * @param {number} [props.delayDuration=300]
 * @param {string} [props.className] Extra classes for the content.
 */
export default function Tooltip({ content, children, side = 'top', delayDuration = 300, className }) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              'z-[70] inline-flex max-w-xs items-center gap-2 rounded-cg-control px-2 py-1',
              'border border-cg-border bg-cg-overlay text-cg-xs text-cg-text font-cg-sans',
              'animate-cg-fade-in',
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
