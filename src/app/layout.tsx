import type { Metadata } from "next";
import { Geist, Geist_Mono, EB_Garamond, Caveat } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
  variable: "--font-garamond",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Libris — 3D Book Notes",
  description:
    "A realistic 3D book you can write inside: real page turns, full-text search, margin notes, and a sticky-note board — persisted across two TiDB clusters.",
  keywords: ["3D book", "note taking", "sticky notes", "TiDB", "reading"],
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/logo.png", type: "image/png" },
    ],
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          No Google Fonts <link>: all four handwriting families ship as local
          woff2 (@font-face in globals.css) plus next/font self-hosting, so a
          remote stylesheet would only fight the production CSP (style-src /
          font-src 'self') and change nothing visually.
        */}
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${ebGaramond.variable} ${caveat.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
