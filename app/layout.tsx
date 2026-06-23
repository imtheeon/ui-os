import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "U-I-OS",
  description: "Unified Intelligence OS",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
