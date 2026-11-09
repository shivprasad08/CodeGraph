import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

/**
 * Fades a section in (200ms opacity + 8px rise) the first time it enters the
 * viewport. Runs once; never loops. Under prefers-reduced-motion the tokens set
 * the duration to 0, so content simply appears.
 */
export default function Reveal({ as: Tag = 'div', className, children, ...props }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (visible || !ref.current) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <Tag
      ref={ref}
      className={cn(
        'transition-[opacity,transform] duration-cg-base ease-cg motion-reduce:transform-none',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
