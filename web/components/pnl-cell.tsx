import { cn } from "@/lib/utils";

export function PnlCell({ value }: { value: number }) {
  const formatted =
    Math.abs(value) >= 1000
      ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
      : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <span
      className={cn(
        "font-mono text-sm tabular-nums",
        value > 0 && "text-emerald-600",
        value < 0 && "text-red-500",
        value === 0 && "text-muted-foreground"
      )}
    >
      {formatted}
    </span>
  );
}
