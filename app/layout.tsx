import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'RefundProof',
  description: 'Evidence-bound, exactly approved PayPal sandbox refunds',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
