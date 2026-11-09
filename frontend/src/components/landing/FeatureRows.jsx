import { cn } from '../../lib/cn';
import Reveal from './Reveal';

// Real app screenshots (WebP, pre-cropped). width/height are the files' intrinsic size.
export const FEATURES = [
  {
    title: 'Blast radius',
    body: 'Select a function and CodeGraph follows its callers through the graph, showing everything that could break if it changes.',
    image: {
      src: '/landing/blast-radius.webp',
      width: 1200,
      height: 750,
      alt: 'CodeGraph simulation mode on shivprasad08/mini_redis: one function is selected and the graph highlights every function that depends on it, grouped by distance.',
    },
  },
  {
    title: 'Health checks',
    body: 'Security and quality findings, each tied to a file and line: eval() calls, hardcoded secrets, long functions, missing docstrings.',
    image: {
      src: '/landing/health-checks.webp',
      width: 450,
      height: 600,
      alt: 'Health panel listing issues by file, including an eval() security risk in cli.py at line 1023 and long functions flagged as quality issues, each with its line number.',
    },
  },
  {
    title: 'Code inspector',
    body: 'Read syntax-highlighted source next to the graph. Function names in the code link back to their nodes.',
    image: {
      src: '/landing/code-inspector.webp',
      width: 1200,
      height: 766,
      alt: 'Code inspector showing views.py from pallets/flask with syntax highlighting, below the graph and beside the file tree.',
    },
  },
  {
    title: 'Ask the codebase',
    body: 'Answers are grounded in the repository’s own structure and cite the files and functions they mention.',
    image: {
      src: '/landing/ask-the-codebase.webp',
      width: 483,
      height: 644,
      alt: 'Chat panel answering “Explain the overall architecture of this project” for pallets/flask, with file and class names linked to the graph.',
    },
  },
];

export default function FeatureRows() {
  return (
    <section aria-labelledby="features-title" className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
      <h2 id="features-title" className="sr-only">
        Features
      </h2>
      <div className="flex flex-col gap-16 md:gap-28">
        {FEATURES.map((feature, i) => {
          const portrait = feature.image.height > feature.image.width;
          return (
            <Reveal key={feature.title} className="grid grid-cols-1 items-center gap-6 md:grid-cols-2 md:gap-16">
              <div className={cn('max-w-[440px]', i % 2 === 1 && 'md:order-2')}>
                <h3 className="text-cg-xl font-semibold text-cg-text">{feature.title}</h3>
                <p className="mt-2 text-cg-base text-cg-secondary">{feature.body}</p>
              </div>
              <div className={cn('flex justify-center', i % 2 === 1 ? 'md:order-1 md:justify-start' : 'md:justify-end')}>
                <figure
                  className={cn(
                    'w-full overflow-hidden rounded-cg-panel border border-cg-border bg-cg-raised shadow-cg-edge',
                    portrait && 'max-w-[340px]',
                  )}
                >
                  <img
                    src={feature.image.src}
                    width={feature.image.width}
                    height={feature.image.height}
                    alt={feature.image.alt}
                    loading="lazy"
                    decoding="async"
                    className="block h-auto w-full"
                  />
                </figure>
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
