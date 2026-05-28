import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/cn";

const segmentControlVariants = cva(
  "grid w-full min-w-0 items-stretch gap-0.5 rounded-lg border border-border bg-surface p-0.5 text-muted-foreground shadow-sm panel:gap-1 panel:p-1",
  {
    variants: {
      size: {
        default: "min-h-10",
        sm: "min-h-9",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const segmentControlItemVariants = cva(
  "inline-flex min-w-0 items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap rounded-md font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 panel:gap-1.5",
  {
    variants: {
      size: {
        default: "px-1.5 py-2 text-[11px] panel:px-3 panel:text-xs",
        sm: "px-1 py-1.5 text-[10px] panel:px-2 panel:text-[11px]",
      },
      active: {
        true: "bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--accent-glow))]",
        false: "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
      },
    },
    defaultVariants: { size: "default", active: false },
  },
);

export interface SegmentControlItem<TValue extends string> {
  value: TValue;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentControlProps<TValue extends string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange">,
    VariantProps<typeof segmentControlVariants> {
  items: readonly SegmentControlItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  ariaLabel: string;
}

export function SegmentControl<TValue extends string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  size,
  className,
  style,
  ...props
}: SegmentControlProps<TValue>): React.ReactElement {
  const gridTemplateColumns = `repeat(${items.length}, minmax(0, 1fr))`;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(segmentControlVariants({ size }), className)}
      style={{ ...style, gridTemplateColumns }}
      {...props}
    >
      {items.map((item) => {
        const isActive = item.value === value;

        const labelTitle = typeof item.label === "string" ? item.label : undefined;
        const labelClassName = item.icon && size === "sm" ? "sr-only panel:not-sr-only panel:truncate" : "truncate";

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={labelTitle}
            disabled={item.disabled}
            className={cn(segmentControlItemVariants({ size, active: isActive }))}
            onClick={() => onValueChange(item.value)}
          >
            {item.icon}
            <span className={labelClassName}>{item.label}</span>
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
