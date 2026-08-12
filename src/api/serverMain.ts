/**
 * Child-process entry point for the Edge Function router: reads its
 * configuration from argv, starts listening, and prints the URL it bound so
 * the parent knows it is ready. See `server.ts` for why it runs out of
 * process.
 */

import { startHttpServer } from './router.ts';

const [port, databaseUrl, writerToken, writerId] = process.argv.slice(2);

if (port === undefined || databaseUrl === undefined || writerToken === undefined || writerId === undefined) {
  throw new Error('usage: serverMain.ts <port> <databaseUrl> <writerToken> <writerId>');
}

const server = await startHttpServer({
  port: Number(port),
  databaseUrl,
  writerToken,
  writerId,
});

process.stdout.write(`listening ${server.url}\n`);

process.on('SIGTERM', () => {
  void server.stop().then(() => process.exit(0));
});
