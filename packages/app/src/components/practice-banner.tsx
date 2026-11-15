import { FlaskConical } from 'lucide-react';
import { PRACTICE_BANNER } from '@cip/contracts';
import { cn } from '@cip/ui';

/**
 * The label every practice screen carries (TRD-06, criterion 14.7), in the practice colour: orders
 * are simulated, and no real money is involved.
 */
export function PracticeBanner({ className }: { className?: string }) {
  return (
    <p
      role="note"
      data-practice-banner=""
      className={cn(
        'flex items-center gap-2 rounded-md border border-practice/60 bg-practice/10 px-3 py-2 text-sm font-medium text-practice',
        className,
      )}
    >
      <FlaskConical className="size-4 shrink-0" aria-hidden />
      {PRACTICE_BANNER}
    </p>
  );
}
