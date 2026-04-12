import type { Metadata } from 'next';
import { Inter, Space_Grotesk, Manrope } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
});

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
});

export const metadata: Metadata = {
  title: 'Kaizen — The QA Brain',
  description: 'Autonomous QA testing that actually understands your interface',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} ${manrope.variable}`}
    >
      <body className="bg-app-bg text-white font-sans min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
