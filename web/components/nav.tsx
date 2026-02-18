"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const CLOUD_URL = "https://polybot-b5l.pages.dev";

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
        <a
          href={`${CLOUD_URL}/copy`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary flex items-center gap-1"
        >
          Cloud Copy
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </nav>
  );
}
