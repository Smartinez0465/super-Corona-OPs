// Minimal service worker so phones offer "Install app". It does not cache anything, so sales data is never stored by it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
