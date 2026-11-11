// The parts of going public that can be tested without opening a tunnel: reading a tunnel's
// address from cloudflared's output, writing the site's config, and serving the built site.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const TUNNEL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * cloudflared prints its address again when it reconnects, so the same address showing up
 * twice is not a new address and attendees must not be told to reload.
 */
export class AddressTracker {
  #current: string | null = null;

  /** "first" the first time, "changed" for a different address, "same" for a repeat. */
  see(url: string): "first" | "changed" | "same" {
    const previous = this.#current;
    this.#current = url;
    if (previous === null) return "first";
    return previous === url ? "same" : "changed";
  }
}

/** The public address a quick tunnel announces in its log, if this line has one. */
export function tunnelUrl(line: string): string | null {
  return TUNNEL.exec(line)?.[0] ?? null;
}

export interface SiteOptions {
  relayerUrl: string;
  explorerUrl?: string | null;
  defaultEventId?: number | null;
  events?: Record<string, { title?: string; description?: string; callUrl?: string }>;
}

/** The config.json the web app reads at load, so one build can point at any relayer. */
export function siteConfig(options: SiteOptions): string {
  const config: Record<string, unknown> = {
    relayerUrl: options.relayerUrl.replace(/\/+$/, ""),
    explorerUrl: options.explorerUrl === undefined ? "https://testnet.nearblocks.io" : options.explorerUrl,
  };
  if (options.defaultEventId !== undefined && options.defaultEventId !== null) config.defaultEventId = options.defaultEventId;
  if (options.events && Object.keys(options.events).length > 0) config.events = options.events;
  return JSON.stringify(config, null, 2) + "\n";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** A static server for the built site. It serves only files under `root` and never lists directories. */
export function siteServer(root: string): Server {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path.includes("\0")) {
      res.writeHead(400).end();
      return;
    }
    const file = normalize(join(base, path === "/" ? "index.html" : path));
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        // The config points at today's tunnel, so it must never be cached.
        "Cache-Control": file.endsWith("config.json") ? "no-store" : "public, max-age=300",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  });
}
