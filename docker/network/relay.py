# PID 1 of the network sidecar. Starts mitmproxy, then copies bytes from the proxy
# socket to it. The socket appears only after mitmproxy accepts connections, so the
# CLI can treat the socket as the readiness signal. The container stops when either
# part stops, so `docker wait` reports both. See docs/SPEC.md §"Network policy".
import asyncio
import os
import sys

SOCKET = "/run/ccairgap-network/sock/proxy.sock"
PROXY = ("127.0.0.1", 8080)


async def pump(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except OSError:
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def handle(client_reader, client_writer):
    try:
        proxy_reader, proxy_writer = await asyncio.open_connection(*PROXY)
    except OSError:
        client_writer.close()
        return
    await asyncio.gather(pump(client_reader, proxy_writer), pump(proxy_reader, client_writer))


async def wait_for_proxy():
    while True:
        try:
            _, writer = await asyncio.open_connection(*PROXY)
            writer.close()
            return
        except OSError:
            await asyncio.sleep(0.1)


async def serve():
    await wait_for_proxy()
    try:
        os.unlink(SOCKET)
    except FileNotFoundError:
        pass
    server = await asyncio.start_unix_server(handle, SOCKET)
    os.chmod(SOCKET, 0o666)
    async with server:
        await server.serve_forever()


async def main():
    proxy = await asyncio.create_subprocess_exec(*sys.argv[1:])
    tasks = {asyncio.create_task(serve()), asyncio.create_task(proxy.wait())}
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    if proxy.returncode is None:
        proxy.kill()
    print("ccairgap network sidecar: the proxy or the relay stopped", file=sys.stderr, flush=True)
    os._exit(1)


asyncio.run(main())
