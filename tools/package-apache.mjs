import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("../dist/client/", import.meta.url);
const destination = new URL("../apache-dist/", import.meta.url);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const textExtensions = new Set([".html", ".js", ".css", ".rsc", ".json"]);

async function rewriteTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteTree(path);
    } else if (textExtensions.has(extname(entry.name))) {
      const original = await readFile(path, "utf8");
      const rewritten = original
        .replaceAll(/(?<!\.)\/assets\//g, "/misa/assets/")
        .replaceAll(/(?<!\.)\/favicon\.svg/g, "/misa/assets/mit-haystack.png")
        .replaceAll('pathname":"/"', 'pathname":"/misa/"');
      await writeFile(path, rewritten);
    }
  }
}

await rewriteTree(fileURLToPath(destination));
await writeFile(
  new URL(".htaccess", destination),
  `DirectoryIndex index.html
Options -MultiViews

<IfModule mod_mime.c>
  AddType application/octet-stream .bin
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml
</IfModule>

<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType application/octet-stream "access plus 7 days"
  ExpiresByType image/jpeg "access plus 30 days"
  ExpiresByType image/svg+xml "access plus 30 days"
  ExpiresByType application/javascript "access plus 30 days"
  ExpiresByType text/css "access plus 30 days"
</IfModule>
`,
);

console.log(`Apache bundle ready at ${fileURLToPath(destination)}`);
