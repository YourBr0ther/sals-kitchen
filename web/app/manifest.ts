import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sal's Kitchen",
    short_name: "Sal",
    description: "Your personal chef. Plans the week's dinners from your Mealie recipe box.",
    start_url: "/",
    display: "standalone",
    background_color: "#E4EEE8",
    theme_color: "#1E4D3A",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
