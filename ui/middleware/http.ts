// Tiny request/response helpers shared by every endpoint handler.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const readJsonBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
