export function Legend({ items }: { items: { term: string; desc: string }[] }) {
  return (
    <details className="mb-3 text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Column guide
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {items.map(({ term, desc }) => (
          <div key={term} className="contents">
            <dt className="font-medium text-foreground">{term}</dt>
            <dd>{desc}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
