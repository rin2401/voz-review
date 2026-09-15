"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddThreadForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState("thread");
  const [pending, startTransition] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    startTransition(true);
    try {
      const response = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed, kind }),
      });
      if (!response.ok) throw new Error(await response.text());
      toast.success("Thread added");
      setUrl("");
      router.refresh();
    } catch (error) {
      toast.error(`Lỗi add thread: ${(error as Error).message}`);
    } finally {
      startTransition(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1 space-y-1.5">
        <label htmlFor="threadUrl" className="text-sm text-muted-foreground">
          Thread URL
        </label>
        <Input
          id="threadUrl"
          type="url"
          required
          placeholder="https://voz.vn/t/..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="w-full space-y-1.5 sm:w-44">
        <label htmlFor="threadKind" className="text-sm text-muted-foreground">
          Kind
        </label>
        <select
          id="threadKind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring"
        >
          <option value="thread">🏢 Company</option>
          <option value="apartment">🏘️ Apartment</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        + Add
      </Button>
    </form>
  );
}

export function CrawlThreadButton({ url, running }: { url: string; running: boolean }) {
  const [state, setState] = useState<"idle" | "pending" | "started">(running ? "started" : "idle");

  async function handleClick() {
    setState("pending");
    try {
      const response = await fetch(
        `/api/crawl/thread?max_pages=0&url=${encodeURIComponent(url)}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
      setState("started");
      toast.success("Crawl started");
    } catch (error) {
      toast.error(`Lỗi crawl thread: ${(error as Error).message}`);
      setState("idle");
    }
  }

  return (
    <Button size="sm" onClick={handleClick} disabled={state !== "idle"}>
      {state === "pending" ? "⏳ Crawling..." : state === "started" ? "✅ Started" : "Crawl"}
    </Button>
  );
}

export function CrawlAllButton() {
  const [state, setState] = useState<"idle" | "pending" | "started" | "already">("idle");

  async function handleClick() {
    setState("pending");
    try {
      const response = await fetch("/api/crawl/all?max_pages=0", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setState(payload.status === "already_running" ? "already" : "started");
    } catch (error) {
      toast.error(`Lỗi crawl all: ${(error as Error).message}`);
      setState("idle");
    }
  }

  return (
    <Button size="sm" onClick={handleClick} disabled={state === "pending"}>
      {state === "pending"
        ? "⏳ Crawling..."
        : state === "started"
          ? "✅ Started"
          : state === "already"
            ? "⏸ Already Running"
            : "🚀 Crawl All"}
    </Button>
  );
}
