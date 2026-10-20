import type { Metadata, Viewport } from "next";
import { Courier_Prime, Instrument_Sans, Shrikhand } from "next/font/google";
import { ServiceWorker } from "@/components/Pwa";
import "./globals.css";

const shrikhand = Shrikhand({ weight: "400", subsets: ["latin"], variable: "--font-shrikhand" });
const instrument = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument" });
const courier = Courier_Prime({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-courier" });

export const metadata: Metadata = {
  title: "Sal's Kitchen",
  description: "Your personal chef. Plans the week's dinners from your Mealie recipe box.",
  applicationName: "Sal's Kitchen",
  icons: { icon: "/icon.svg", apple: "/icon-180.png" },
  appleWebApp: { capable: true, title: "Sal", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, address: false, email: false },
  // Next emits the newer mobile-web-app-capable; older iPhones only honor Apple's name for it
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1E4D3A" },
    { media: "(prefers-color-scheme: dark)", color: "#10241b" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

const THEME_SCRIPT = `try{var t=localStorage.getItem("sal-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // the saved theme is applied before first paint, so a dark-mode phone never flashes white
    <html lang="en" className={`${shrikhand.variable} ${instrument.variable} ${courier.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
