import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import localFont from "next/font/local";
import { Providers } from "@/components/providers";
import "./globals.css";

// Self-hosted (no build-time fetch from Google Fonts).
const sans = GeistSans;
const mono = GeistMono;
const display = localFont({
  src: "../node_modules/@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2",
  variable: "--font-display",
  weight: "400 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Unified CRM", template: "%s · Unified CRM" },
  description: "Internal multi-brand CRM for Logic Tech Digital, Xpectra and CoreByte.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
