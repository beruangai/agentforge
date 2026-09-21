// Stands in for the bundled A2A server. Its content is irrelevant to §D; what
// matters is that it is one file whose bytes are fixed by the base image.
const port = Number(process.env.A2A_PORT ?? 9000);
Bun.serve({ port, fetch: () => new Response(JSON.stringify({ status: 'Healthy' })) });
