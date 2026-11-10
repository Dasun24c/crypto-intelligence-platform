import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import { Slot } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-strong',
        secondary: 'border border-border-strong bg-surface-2 text-fg hover:bg-surface-3',
        ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        danger: 'bg-crit/15 text-crit border border-crit/40 hover:bg-crit/25',
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-4', lg: 'h-10 px-5' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  busy?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild,
  busy,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? busy}
      aria-busy={busy}
      {...props}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </Comp>
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle',
        'aria-invalid:border-crit',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-fg-muted', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn('h-9 rounded-md border border-border-strong bg-surface px-2 text-sm text-fg', className)}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-lg border border-border bg-surface', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      className={cn('flex items-center justify-between gap-4 border-b border-border px-4 py-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-sm font-semibold text-fg', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-surface-3 text-fg-muted',
      ok: 'bg-ok/15 text-ok',
      warn: 'bg-warn/15 text-warn',
      crit: 'bg-crit/15 text-crit',
      info: 'bg-info/15 text-info',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export type StatusTone = 'ok' | 'warn' | 'crit' | 'info';
const STATUS_ICON = { ok: CheckCircle2, warn: AlertTriangle, crit: XCircle, info: Info } as const;

/** A status is never colour alone: it always carries an icon and a text label. */
export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  const Icon = STATUS_ICON[tone];
  return (
    <Badge tone={tone}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </Badge>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: StatusTone;
  title: string;
  children?: ReactNode;
}) {
  const Icon = STATUS_ICON[tone];
  // Full class names (not built from strings) so Tailwind can see them.
  const colours = {
    ok: 'border-ok/40',
    warn: 'border-warn/40',
    crit: 'border-crit/40',
    info: 'border-info/40',
  }[tone];
  const iconColour = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit', info: 'text-info' }[tone];
  return (
    <div
      role={tone === 'crit' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border bg-surface-2 p-3 text-sm', colours)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconColour)} aria-hidden />
      <div>
        <p className="font-medium text-fg">{title}</p>
        {children ? <div className="mt-1 text-fg-muted">{children}</div> : null}
      </div>
    </div>
  );
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-border px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-fg-subtle',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td className={cn('border-b border-border/60 px-3 py-2 align-middle text-fg', className)} {...props} />
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}
