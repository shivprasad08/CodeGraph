import { forwardRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import IconButton from './IconButton';

/**
 * Dialog — Radix dialog. Focus is trapped while open and restored to the
 * trigger on close; Esc and the close button dismiss it. Scrim is
 * rgba(0,0,0,0.6) with no blur.
 *
 * Usage:
 *   <Dialog>
 *     <DialogTrigger asChild><Button>Delete cache</Button></DialogTrigger>
 *     <DialogContent title="Delete cached analysis?" description="…" footer={…}>…</DialogContent>
 *   </Dialog>
 *
 * DialogContent props:
 * @param {import('react').ReactNode} props.title Required (accessible name).
 * @param {import('react').ReactNode} [props.description] Linked via aria-describedby.
 * @param {import('react').ReactNode} [props.footer] Actions, right-aligned.
 * @param {'center'|'left'|'right'} [props.side='center'] 'left'/'right' render a full-height sheet.
 * @param {boolean} [props.bare] No header, padding or close button; the title stays for
 *   screen readers. For custom layouts such as a command palette.
 * @param {string} [props.className]
 * @param {string} [props.bodyClassName]
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const POSITION = {
  center: cn(
    'left-1/2 top-1/2 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2',
    'rounded-cg-panel border border-cg-border animate-cg-scale-in',
  ),
  left: 'inset-y-0 left-0 h-dvh w-[min(320px,calc(100vw-48px))] border-r border-cg-border animate-cg-sheet-left',
  right: 'inset-y-0 right-0 h-dvh w-[min(380px,calc(100vw-48px))] border-l border-cg-border animate-cg-sheet-right',
};

export const DialogContent = forwardRef(function DialogContent(
  { title, description, footer, side = 'center', bare = false, className, bodyClassName, children, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60 animate-cg-fade-in" />
      <DialogPrimitive.Content
        ref={ref}
        {...(description ? {} : { 'aria-describedby': undefined })}
        className={cn(
          'fixed z-[60] flex flex-col bg-cg-overlay shadow-cg-edge font-cg-sans focus:outline-none',
          POSITION[side],
          className,
        )}
        {...props}
      >
        {bare ? (
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        ) : (
          <div className="flex items-start gap-3 px-5 pb-2 pt-5">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-cg-lg font-semibold text-cg-text">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-cg-sm text-cg-secondary">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="Close" tooltip={false} size="sm" className="-mr-1.5 -mt-1">
                <X size={16} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
        )}
        {bare
          ? children
          : children && (
              <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-2 text-cg-sm text-cg-text', bodyClassName)}>
                {children}
              </div>
            )}
        {footer && <div className="flex flex-wrap justify-end gap-2 px-5 pb-5 pt-3">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
