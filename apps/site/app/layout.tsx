import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Panopticon — 다중 지성 관측실",
  description: "각자의 AI와 함께 대화하고 서로의 답을 검증하는 방.",
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
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
