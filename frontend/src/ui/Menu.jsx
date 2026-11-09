import { forwardRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '../lib/cn';

/**
 * Menu — Radix dropdown menu on the overlay surface. Arrow keys move, Enter
 * selects, Esc closes and returns focus to the trigger.
 *
 *   <Menu>
 *     <MenuTrigger asChild><IconButton label="More">…</IconButton></MenuTrigger>
 *     <MenuContent align="end"><MenuItem onSelect={…} icon={<Plus />}>New analysis</MenuItem></MenuContent>
 *   </Menu>
 */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export const MenuContent = forwardRef(function MenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-[70] min-w-48 rounded-cg-control border border-cg-border bg-cg-overlay p-1 font-cg-sans shadow-cg-edge animate-cg-fade-in',
          className,
        )}
        {...props}
      />
    </DropdownMenu.Portal>
  );
});

/**
 * @param {import('react').ReactNode} [props.icon] 16px Lucide icon.
 * @param {import('react').ReactNode} [props.shortcut] Optional key hint on the right.
 */
export const MenuItem = forwardRef(function MenuItem({ icon, shortcut, className, children, ...props }, ref) {
  return (
    <DropdownMenu.Item
      ref={ref}
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-cg-sm text-cg-text outline-none',
        'data-[highlighted]:bg-cg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[@media(pointer:coarse)]:min-h-11',
        className,
      )}
      {...props}
    >
      {icon && <span className="text-cg-secondary">{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut}
    </DropdownMenu.Item>
  );
});

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-cg-border" />;
