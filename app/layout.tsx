import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SignalOps — Observability optimizer",
  description: "Find evidence-backed optimization opportunities in Prometheus metrics, Splunk events, and application logs.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
