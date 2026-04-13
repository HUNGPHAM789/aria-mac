import http from 'http';

// MC Group Chat API — the correct endpoint to reach Jarvis
const MC_CHAT_HOST = '127.0.0.1';
const MC_CHAT_PORT = 3333;
const MC_CHAT_PATH = '/api/group-chat';

export interface JarvisResponse {
  success: boolean;
  reply?: string;
  error?: string;
}

/**
 * Send a message to Jarvis via the Mission Control Group Chat API.
 * Message should include @jarvis mention so Jarvis picks it up.
 */
export function sendToJarvis(message: string): Promise<JarvisResponse> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ sender: 'aria', message });

    const req = http.request(
      {
        hostname: MC_CHAT_HOST,
        port: MC_CHAT_PORT,
        path: MC_CHAT_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { reply?: string };
            resolve({ success: true, reply: parsed.reply });
          } catch {
            resolve({ success: true, reply: body });
          }
        });
      },
    );

    req.setTimeout(10_000, () => {
      req.destroy();
      resolve({ success: false, error: 'MC Chat API timeout' });
    });

    req.on('error', (err: Error) => {
      resolve({ success: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}
