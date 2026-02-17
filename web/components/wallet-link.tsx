"use client";

import Link from "next/link";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function truncate(address: string) {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function truncateName(name: string, max = 20) {
  if (name.length <= max) return name;
  return `${name.slice(0, max)}...`;
}

export function WalletLink({
  address,
  username,
  onCopyTrade,
}: {
  address: string;
  username?: string;
  onCopyTrade?: (wallet: string) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={`/wallet/${address}`}
            className="text-sm text-primary hover:underline"
          >
            {username ? (
              <span className="font-medium">{truncateName(username)}</span>
            ) : (
              <span className="font-mono">{truncate(address)}</span>
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent>
          {username && <p className="text-xs">{username}</p>}
          <p className="font-mono text-xs">{address}</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-5 w-5" asChild>
            <a
              href={`https://polymarket.com/profile/${address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open on Polymarket</TooltipContent>
      </Tooltip>
      {onCopyTrade && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => onCopyTrade(address)}
            >
              <UserPlus className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy trade this wallet</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
