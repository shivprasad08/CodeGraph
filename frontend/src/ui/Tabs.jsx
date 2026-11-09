import { forwardRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../lib/cn';
import { focusRing } from './focusRing';

/**
 * Tabs — Radix tabs. Arrow keys move between tabs (automatic activation),
 * Home/End jump to the ends. Active tab: text colour + 2px underline, no pill.
 *
 * Usage:
 *   <Tabs defaultValue="graph">
 *     <TabsList aria-label="View"><TabsTrigger value="graph">Graph</TabsTrigger>…</TabsList>
 *     <TabsContent value="graph">…</TabsContent>
 *   </Tabs>
 * Props are passed through to the Radix primitives.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('flex items-stretch gap-1 overflow-x-auto border-b border-cg-border', className)}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'relative inline-flex h-9 shrink-0 items-center px-3 [@media(pointer:coarse)]:min-h-11',
        'font-cg-sans text-cg-sm font-medium text-cg-secondary',
        'transition-colors duration-cg-fast ease-cg hover:text-cg-text',
        'data-[state=active]:text-cg-text',
        'after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-transparent',
        'data-[state=active]:after:bg-cg-text',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'rounded-t-cg-control',
        focusRing,
        // Inset ring: the list scrolls horizontally and would clip an outer ring
        'focus-visible:outline-offset-[-2px]',
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn('pt-4 rounded-cg-control', focusRing, className)}
      {...props}
    />
  );
});
