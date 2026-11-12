import type { ReactNode } from 'react';

export const metadata = {
  title: 'RefundProof',
  description: 'Evidence-bound, exactly-approved PayPal sandbox refunds',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
