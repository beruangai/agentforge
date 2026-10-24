// Serves a directory's files over HTTPS, read-only, in a process of its own:
// git's dumb HTTP protocol needs nothing more, and the test's own process
// blocks on git while it runs. Prints the port once listening.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join, normalize } from 'node:path';

const [root, key, cert] = process.argv.slice(2);
const server = createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (request, response) => {
    const path = normalize(new URL(request.url ?? '/', 'https://x').pathname);
    const file = join(root, path);
    if (
      request.method !== 'GET' ||
      !file.startsWith(root) ||
      !existsSync(file)
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(readFileSync(file));
  },
);
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
