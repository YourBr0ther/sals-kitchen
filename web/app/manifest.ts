import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Sal's Kitchen",
    short_name: "Sal",
    description: "Your personal chef. Plans the week's dinners from your Mealie recipe box.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#E4EEE8",
    theme_color: "#1E4D3A",
    categories: ["food", "lifestyle"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Talk to Sal", short_name: "Chat", url: "/?tab=chat", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "This week's dinners", short_name: "This week", url: "/?tab=week", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "Grocery list", short_name: "Groceries", url: "/?tab=week&list=1", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
