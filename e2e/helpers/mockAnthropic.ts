import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockAnthropic {
  url: string;
  observedBearers: string[];
  close(): Promise<void>;
}

/**
 * Minimal localhost mock for api.anthropic.com `/v1/messages`. Records the
 * Authorization header bearer of every request and returns a fixed assistant
 * turn. NOT a faithful API implementation — just enough for `claude --print
 * <prompt>` to complete a turn.
 */
export async function startMockAnthropic(): Promise<MockAnthropic> {
  const observedBearers: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      observedBearers.push(auth.slice("Bearer ".length));
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "mock",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          model: "claude-mock",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    observedBearers,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
