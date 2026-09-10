import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import "./katex-woff2.css";
import "./globals.css";
import "../components/IfcnResults.css";
import "../components/IfcnAlgorithms.css";
import "../components/IfcnDesignForm.css";

export const metadata: Metadata = {
  title: "FCNPilot 电路设计",
  description: "面向场耦合纳米电路的 iFCN 主智能体：从 Verilog、DAG 到布局布线、QCA 器件版图和数值分析。",
  applicationName: "FCNPilot",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg?v=ifcn-circuit-v2", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "FCNPilot",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      translate="no"
      className="notranslate"
      suppressHydrationWarning
    >
      <head>
        <meta name="google" content="notranslate" />
        {process.env.NODE_ENV === "development" && (
          <script dangerouslySetInnerHTML={{
            // A previous production worker can otherwise serve stale dev chunks.
            __html: `(async function(){if(!("serviceWorker" in navigator))return;try{var registrations=await navigator.serviceWorker.getRegistrations();var own=registrations.filter(function(r){var w=r.active||r.waiting||r.installing;return w&&new URL(w.scriptURL).origin===location.origin&&new URL(w.scriptURL).pathname==="/sw.js"});if(!own.length)return;await Promise.all(own.map(function(r){return r.unregister()}));var keys=await caches.keys();await Promise.all(keys.filter(function(k){return k.startsWith("fcnpilot-web-")}).map(function(k){return caches.delete(k)}));location.reload()}catch(e){console.warn("Could not clear development asset cache",e)}})();`,
          }} />
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){if(window.__amedacMonacoCancellationGuard)return;window.__amedacMonacoCancellationGuard=true;function canceled(r){var s=r&&String(r.stack||"");return r&&r.name==="Canceled"&&r.message==="Canceled"&&(s.indexOf("monaco-editor")>=0||s.indexOf("vs/base/common/")>=0)}window.addEventListener("unhandledrejection",function(e){if(!canceled(e.reason))return;e.preventDefault();e.stopImmediatePropagation()},true);window.addEventListener("error",function(e){if(!canceled(e.error))return;e.preventDefault();e.stopImmediatePropagation()},true)})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");var dark=t==="dark"||((t==null||t===""||t==="auto")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
      </head>
      <body
        translate="no"
        className="notranslate"
        suppressHydrationWarning
        style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
      >
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
