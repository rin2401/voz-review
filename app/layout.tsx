import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";

import { SiteNavbar } from "@/components/site-navbar";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "V⭕Z Review",
  description: "Crawl và tổng hợp review công ty từ voz.vn",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" suppressHydrationWarning className={cn("font-sans", geist.variable)}>
      <body className="min-h-screen bg-background font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <SiteNavbar />
          <main className="mx-auto w-full max-w-6xl px-4 py-4">{children}</main>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
