// Runs in the agent container, which has only a loopback interface.
// Copies bytes from 127.0.0.1:3128 to the proxy socket. It enforces nothing:
// the policy lives in the sidecar, and an agent that kills this process only
// loses its network access. See docs/SPEC.md §"Network policy".
import net from "node:net";

const SOCKET = "/run/ccairgap-network/sock/proxy.sock";

const server = net.createServer((client) => {
  const upstream = net.connect(SOCKET);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (err) => {
  console.error(`ccairgap network forwarder: ${err.message}`);
  process.exit(1);
});
server.listen(3128, "127.0.0.1");
