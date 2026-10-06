import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/vt323/400.css";
import "./globals.css";
import RatMark from "@/components/RatMark";
import Nav from "@/components/Nav";
import CaBar from "@/components/CaBar";
import Heartbeat from "@/components/Heartbeat";
import { WalletProvider, WalletButton } from "@/components/Wallet";
import { SITE } from "@/config/site";


export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: "RATNET · the model raised in the trenches",
  description: `${SITE.tagline} ${SITE.sub}`,
  openGraph: { title: "RATNET", description: SITE.tagline, siteName: "RATNET" },
  twitter: { card: "summary_large_image", title: "RATNET", description: SITE.tagline },
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = { themeColor: "#060807", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <Heartbeat />
          <header className="top">
            <div className="wrap">
              <Link href="/" className="brand">
                <RatMark size={30} />
                RATNET
              </Link>
              <Nav />
              <WalletButton />
            </div>
          </header>
          <CaBar />
          <main>
            <div className="wrap">{children}</div>
          </main>
          <footer>
            <div className="wrap row between wrapx">
              <span>RATNET · $RAT · rats dig, the king learns, the weights go public.</span>
              <span>
                <Link href="/docs">docs</Link> · <Link href="/ledger">ledger</Link> · <Link href="/dataset">dataset</Link>
              </span>
            </div>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
