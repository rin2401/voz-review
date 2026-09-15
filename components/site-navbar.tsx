"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { Menu, Moon, Sun, X } from "lucide-react";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/", label: "🏢 Company" },
  { href: "/apartments", label: "🏘️ Apartments" },
  { href: "/threads", label: "🧵 Threads" },
];

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="hidden h-4 w-4 dark:block" />
    </Button>
  );
}

export function SiteNavbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <Collapsible open={open} onOpenChange={setOpen}>
        <nav className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="text-lg">V⭕Z</span>
            <span className="text-muted-foreground">Review</span>
          </Link>
          <div className="ml-auto hidden items-center gap-1 sm:flex">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              >
                {link.label}
              </Link>
            ))}
            <ThemeToggle />
          </div>
          <div className="ml-auto flex items-center gap-1 sm:hidden">
            <ThemeToggle />
            <CollapsibleTrigger
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
              aria-label="Toggle navigation menu"
            >
              {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </CollapsibleTrigger>
          </div>
        </nav>
        <CollapsibleContent className="sm:hidden">
          <div className="border-t">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-2">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "justify-start",
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </header>
  );
}
