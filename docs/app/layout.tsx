import { Inter, Sora, Fragment_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

// Inter for body, Sora for headings, Fragment Mono for code — exposed as
// CSS variables and consumed via --font-sans / --font-display / --font-mono
// in global.css + observability.css.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const sora = Sora({ subsets: ['latin'], variable: '--font-sora' });
const fragmentMono = Fragment_Mono({
  subsets: ['latin'],
  weight: '400', // Fragment Mono ships a single weight
  variable: '--font-fragment-mono',
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${sora.variable} ${fragmentMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
