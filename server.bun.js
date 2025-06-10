// server.bun.js
import fs from "fs";
import path from "path";

const PORT = 5500;
const HOSTNAME = "127.0.0.1";
const PUBLIC_DIR = import.meta.dir; // Assuming assets are in the same directory as server.js
const HTML_FILE_PATH = path.join(PUBLIC_DIR, "index.html");

// Store active SSE client controllers
let sseClients = new Set();

// --- File Watcher (currently only watches index.html) ---
// We can extend this later to watch CSS files too.
const filesToWatch = [HTML_FILE_PATH]; // Start with index.html
// You can add your CSS files here if you want them to trigger a reload:
filesToWatch.push(path.join(PUBLIC_DIR, "style.css"));
filesToWatch.push(path.join(PUBLIC_DIR, "style-start.css"));

for (const filePathToWatch of filesToWatch) {
  try {
    fs.unwatchFile(filePathToWatch);
  } catch (e) {
    /* ignore */
  } // Prevent multiple watchers
  fs.watchFile(filePathToWatch, { interval: 500 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      console.log(
        `${path.basename(filePathToWatch)} changed. Sending reload event to ${
          sseClients.size
        } client(s).`
      );
      for (const client of sseClients) {
        try {
          client.controller.enqueue("data: reload\n\n");
        } catch (e) {
          console.warn("Failed to send reload event to a client, removing.");
          sseClients.delete(client);
          try {
            client.controller.close();
          } catch (err) {
            /* ignore */
          }
        }
      }
    }
  });
}

// --- Bun HTTP Server ---
const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,

  async fetch(req) {
    // Made fetch async to use await file.exists()
    const url = new URL(req.url);
    const pathname = url.pathname;

    // SSE Endpoint for Live Reload
    if (pathname === "/live-reload-events") {
      let clientController;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          const clientInfo = { controller };
          sseClients.add(clientInfo);
          console.log(
            `Client connected for live reload. Total clients: ${sseClients.size}`
          );
        },
        cancel() {
          const clientToRemove = Array.from(sseClients).find(
            (c) => c.controller === clientController
          );
          if (clientToRemove) sseClients.delete(clientToRemove);
          console.log(
            `Client disconnected from live reload. Total clients: ${sseClients.size}`
          );
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Determine the file path for static assets
    let requestedFilePath = path.join(PUBLIC_DIR, pathname);
    if (pathname === "/" || pathname === "/index.html") {
      requestedFilePath = HTML_FILE_PATH;
    } else {
      // For security, ensure path doesn't try to escape the public directory
      // This is a basic check; more robust path traversal prevention might be needed for production
      if (!requestedFilePath.startsWith(PUBLIC_DIR)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    try {
      const file = Bun.file(requestedFilePath);
      const fileExists = await file.exists(); // Check if file exists

      if (fileExists) {
        let contentType = "application/octet-stream"; // Default
        if (requestedFilePath.endsWith(".html")) {
          contentType = "text/html; charset=utf-8";
        } else if (requestedFilePath.endsWith(".css")) {
          contentType = "text/css; charset=utf-8";
        } else if (requestedFilePath.endsWith(".js")) {
          contentType = "application/javascript; charset=utf-8";
        } // Add more MIME types as needed (png, jpg, svg, etc.)

        return new Response(file, {
          headers: { "Content-Type": contentType },
        });
      }
    } catch (e) {
      console.error(`Error serving file ${requestedFilePath}:`, e);
      // Fall through to 404 if there's an error during file processing
    }

    // Handle 404 Not Found for anything else
    console.log(
      `File not found: ${requestedFilePath} (requested path: ${pathname})`
    );
    return new Response("Page Not Found", { status: 404 });
  },

  error(error) {
    console.error("Server error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`Bun server running on http://${server.hostname}:${server.port}`);
console.log(`Serving files from: ${PUBLIC_DIR}`);
if (filesToWatch.length > 0) {
  console.log(
    `Watching for changes in: ${filesToWatch
      .map((f) => path.basename(f))
      .join(", ")}`
  );
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nGracefully shutting down...");
  for (const filePathToWatch of filesToWatch) {
    fs.unwatchFile(filePathToWatch);
  }
  for (const client of sseClients) {
    try {
      client.controller.close();
    } catch (e) {
      /* ignore */
    }
  }
  sseClients.clear();
  server.stop(true);
  process.exit(0);
});
