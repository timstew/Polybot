import { Badge } from "@/components/ui/badge";

const categoryStyles: Record<string, string> = {
  crypto: "bg-blue-100 text-blue-800 border-blue-200",
  politics: "bg-purple-100 text-purple-800 border-purple-200",
  sports: "bg-green-100 text-green-800 border-green-200",
  finance: "bg-amber-100 text-amber-800 border-amber-200",
  "pop culture": "bg-pink-100 text-pink-800 border-pink-200",
  "crypto markets": "bg-sky-100 text-sky-800 border-sky-200",
};

export function CategoryBadge({ category }: { category: string }) {
  const style = categoryStyles[category] || "bg-gray-100 text-gray-800 border-gray-200";
  return (
    <Badge variant="outline" className={`text-xs ${style}`}>
      {category}
    </Badge>
  );
}

export function CategoryBadges({ categories }: { categories: string[] }) {
  if (!categories.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {categories.map((c) => (
        <CategoryBadge key={c} category={c} />
      ))}
    </div>
  );
}
