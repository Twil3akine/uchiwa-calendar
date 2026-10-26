import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://uchiwa-calendar.twil3akine.workers.dev"),
  title: "うちわカレンダー｜みんなの予定を、ひとつに。",
  description: "家族や友だちと決まった予定を共有できる、シンプルな終日カレンダー。",
  robots: { index: false, follow: false },
  openGraph: {
    title: "うちわカレンダー",
    description: "みんなの予定を、ひとつに。URLで集まる、終日予定の共有カレンダー。",
    url: "/",
    siteName: "うちわカレンダー",
    locale: "ja_JP",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "うちわカレンダー — みんなの予定を、ひとつに。" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "うちわカレンダー",
    description: "みんなの予定を、ひとつに。URLで集まる、終日予定の共有カレンダー。",
    images: ["/og.png"],
  },
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
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
