import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "RefundDesk Pilot",
  description: "Stripe refund approval pilot",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#f6f8fa",
          color: "#1f2937",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
