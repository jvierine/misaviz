import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MISA Horizon Sweep | Millstone Hill",
  description: "Interactive WebGL visualization of the April 2024 MISA low-elevation windshield-wiper scan.",
  openGraph: {
    title: "MISA Horizon Sweep",
    description: "Explore three days of Millstone Hill low-elevation plasma scans in an interactive WebGL globe.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "MISA Horizon Sweep",
    description: "Millstone Hill's April 2024 windshield-wiper scan, rendered in WebGL.",
  },
  icons: {
    icon: "./assets/mit-haystack.png",
    shortcut: "./assets/mit-haystack.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
