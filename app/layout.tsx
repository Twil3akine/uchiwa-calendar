import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "うちわカレンダー｜みんなの予定を、ひとつに。",
  description: "家族や友だちと決まった予定を共有できる、シンプルな終日カレンダー。",
  robots: { index: false, follow: false },
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
