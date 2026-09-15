import { cookies } from "next/headers";
import Link from "next/link";

import { AddThreadForm, CrawlAllButton, CrawlThreadButton } from "@/components/threads-actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { THREADS_AUTH_COOKIE, isThreadsAuthed } from "@/lib/auth";
import {
  getAllCompanies,
  getAllThreads,
  getCompanyReviewCount,
  getHourlySchedulerStatus,
  getOfferCount,
  getReviewCount,
  refreshThreadJobStatuses,
} from "@/lib/db/queries";
import { formatDtVn, schedulerStatusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const cookieStore = await cookies();
  const authed = isThreadsAuthed(cookieStore.get(THREADS_AUTH_COOKIE)?.value);

  if (!authed) {
    return (
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">🔒 Threads Authentication</h2>
          </CardHeader>
          <CardContent>
            <form action="/threads/login" method="post" className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="threads-password" className="text-sm text-muted-foreground">
                  Password
                </label>
                <Input
                  id="threads-password"
                  type="password"
                  name="password"
                  required
                  autoFocus
                />
              </div>
              {error && <p className="text-sm text-destructive">Sai mật khẩu.</p>}
              <Button type="submit" className="w-full">
                Unlock Threads
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  await refreshThreadJobStatuses();
  const threads = await getAllThreads();
  const totalReviews = await getReviewCount();
  const totalCompanyReviews = await getCompanyReviewCount();
  const totalCompanies = (await getAllCompanies()).length;
  const totalOffers = await getOfferCount();
  const schedulerState = await getHourlySchedulerStatus();

  const stats = [
    { label: "Total Reviews", value: totalReviews },
    { label: "Company Reviews", value: totalCompanyReviews },
    { label: "Company", value: totalCompanies },
    { label: "Offers", value: totalOffers },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="flex flex-col items-center justify-center py-6">
              <span className="text-3xl font-bold text-primary">{stat.value}</span>
              <span className="text-sm text-muted-foreground">{stat.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          <AddThreadForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">⏰ Hourly Scheduler</h2>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-sm text-muted-foreground">Status</p>
              <p className="font-medium">{schedulerStatusLabel(schedulerState)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Timezone</p>
              <p className="font-medium">{schedulerState?.timezone ?? "-"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Next Run</p>
              <p className="font-medium">{formatDtVn(schedulerState?.next_run_at)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last Finished</p>
              <p className="font-medium">{formatDtVn(schedulerState?.last_finished_at)}</p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-sm text-muted-foreground">Last Result</p>
              <p className="font-medium break-words">{schedulerState?.last_result ?? "-"}</p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-sm text-muted-foreground">Last Error</p>
              <p className="font-medium break-words">{schedulerState?.last_error ?? "-"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between space-y-0 gap-2">
          <h2 className="text-lg font-semibold">🧵 Threads</h2>
          <div className="flex items-center gap-3">
            <CrawlAllButton />
            <Link href="/threads" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              ↻ Refresh
            </Link>
            <span className="text-sm text-muted-foreground">{threads.length} threads</span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Page</TableHead>
                    <TableHead>Last</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {threads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        Chưa có thread nào trong DB.
                      </TableCell>
                    </TableRow>
                  ) : (
                    threads.map((thread) => {
                      const threadUrl = thread.url || "";
                      const lastPage = thread.last_page || 0;
                      const href = lastPage > 1 ? `${threadUrl}page-${lastPage}/` : threadUrl;
                      return (
                        <TableRow key={String(thread._id ?? thread.url)}>
                          <TableCell>
                            <a href={href} target="_blank" rel="noreferrer">
                              <Badge variant="secondary">{thread.thread_id || "-"}</Badge>
                            </a>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {thread.kind === "apartment" ? "🏘️ Apartment" : "🏢 Company"}
                            </Badge>
                          </TableCell>
                        <TableCell>{thread.last_page || "-"}</TableCell>
                        <TableCell>{thread.last_crawl ? formatDtVn(thread.last_crawl) : "-"}</TableCell>
                        <TableCell>{thread.crawl_status || "idle"}</TableCell>
                        <TableCell>
                          <CrawlThreadButton url={threadUrl} running={thread.crawl_status === "running"} />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
