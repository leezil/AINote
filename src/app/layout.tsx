import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AINote — 강의 필기",
  description: "문서·필기와 범위가 명확한 AI 질문",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
        <header className="border-b border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
          <h1 className="text-lg font-semibold tracking-tight">AINote</h1>
          <p className="text-xs text-zinc-500">
            질문 버튼을 누를 때만 AI 호출 · 범위(페이지/화면)만 컨텍스트로 전달
          </p>
        </header>
        {children}
      </body>
    </html>
  );
}
