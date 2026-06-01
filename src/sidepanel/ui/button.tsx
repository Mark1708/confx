import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex min-w-0 items-center justify-center gap-2 rounded-md text-center text-sm font-medium leading-tight transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_0_16px_hsl(var(--accent-glow))] hover:bg-primary/90 hover:shadow-[0_0_24px_hsl(var(--accent-glow))]",
        accent:
          "bg-gradient-to-br from-primary via-primary to-success text-primary-foreground shadow-[0_0_22px_hsl(var(--accent-glow))] hover:brightness-110 hover:shadow-[0_0_30px_hsl(var(--accent-glow))]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:shadow-[0_0_18px_hsl(var(--destructive)/0.25)]",
        outline:
          "border border-border bg-surface text-foreground shadow-sm hover:border-primary/60 hover:bg-surface-hover hover:text-foreground hover:shadow-[0_0_14px_hsl(var(--accent-glow))]",
        secondary:
          "border border-border bg-secondary text-secondary-foreground shadow-sm hover:bg-surface-hover hover:text-foreground",
        ghost: "hover:bg-surface-hover hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3 py-2 wide-panel:px-4",
        sm: "h-8 px-2.5 text-xs wide-panel:px-3",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = "Button";
