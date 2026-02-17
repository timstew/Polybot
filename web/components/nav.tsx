"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/copy", label: "Copy Trading" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-6 border-b px-6 py-3">
      <Link href="/" className="text-lg font-bold tracking-tight">
        Polybot
      </Link>
      <div className="flex items-center gap-4">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "text-sm font-medium transition-colors hover:text-primary",
              pathname === link.href ? "text-primary" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
