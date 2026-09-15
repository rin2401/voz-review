"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <nav className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="text-lg">V⭕Z</span>
          <span className="text-muted-foreground">Review</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <Link href="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            🏢 Company
          </Link>
          <Link href="/apartments" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            🏘️ Apartments
          </Link>
          <Link href="/threads" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
            🧵 Threads
          </Link>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
