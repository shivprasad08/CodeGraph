import { cn } from '../lib/cn';

/**
 * Divider — 1px hairline.
 * @param {object} props
 * @param {'horizontal'|'vertical'} [props.orientation='horizontal']
 * @param {boolean} [props.decorative=true] Hidden from assistive tech unless it separates
 *   meaningful groups.
 * @param {string} [props.className]
 */
export default function Divider({ orientation = 'horizontal', decorative = true, className }) {
  const vertical = orientation === 'vertical';
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      className={cn('shrink-0 bg-cg-border', vertical ? 'w-px self-stretch' : 'h-px w-full', className)}
    />
  );
}
