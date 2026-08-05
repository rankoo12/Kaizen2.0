import type { Metadata } from 'next';
import { Inter, Space_Grotesk, Manrope } from 'next/font/google';
import { Providers } from '@/components/providers';
import { ThemeScript } from '@/components/atoms/theme-script';
import './globals.css';
/* Must load AFTER globals.css. `[data-appearance=aperture]` and `:root` have identical
 * specificity (0-1-0), so the later stylesheet wins — importing aperture first (via an
 * @import at the top of globals.css) let the base light tokens override the whole skin. */
import './aperture.css';

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
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      {/* No colour utilities here on purpose. `text-white` used to live on <body>, so
          anything that didn't set its own colour inherited white — invisible once the
          ground went light. globals.css owns body colour/background via the tokens. */}
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
