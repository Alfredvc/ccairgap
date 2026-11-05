# mitmproxy addon that enforces a ccairgap network policy.
# The contract is in docs/SPEC.md §"Network policy".
#
# Each decision logs the stage, verdict, reason, method, host, port and path. The
# log never holds header values, query strings or bodies, because those can hold
# credentials.
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import unicodedata

from mitmproxy import http

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "policy.json")) as _policy_file:
    POLICY = json.load(_policy_file)
CREDENTIAL_DIR = os.path.join(HERE, "credentials")
CREDENTIAL_HOSTS = set(POLICY["credentialHosts"])
DENIED_BODY = b"denied by ccairgap network policy\n"
# Each of these can make a server act on another method, path or host than the
# one that the rules checked.
ROUTING_HEADERS = {
    "x-http-method-override",
    "x-http-method",
    "x-method-override",
    "x-original-url",
    "x-rewrite-url",
    "x-forwarded-host",
    "x-forwarded-server",
    "x-original-host",
    "x-host",
    "forwarded",
}
TOKEN_HEADERS = {"authorization", "x-api-key"}
HEADER_NAME = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
HEADER_VALUE_BAD = re.compile(rb"[\x00\r\n]")
HTTP_VERSIONS = ("HTTP/1.0", "HTTP/1.1")
MAX_DECODE_ROUNDS = 8
MAX_PATH_BYTES = 8192
LOG_PATH_CHARS = 512
# mitmproxy reads a whole request body before it sends a response that a hook set.
# A denied request above this size is killed, so an agent cannot fill the memory.
MAX_DENIED_BODY_BYTES = 1024 * 1024
PERCENT = re.compile(rb"%([0-9a-fA-F]{2})")
PERCENT_U = re.compile(r"%u[0-9a-fA-F]{4}", re.IGNORECASE)
SLASHES = re.compile(r"/+")

# Addresses that ipaddress reports as global, but that are not public destinations.
BLOCKED_NETWORKS = [
    ipaddress.ip_network(n)
    for n in (
        "168.63.129.16/32",  # Azure wire server
        "100.100.100.200/32",  # Alibaba metadata service
        "192.88.99.0/24",  # deprecated 6to4 relay anycast
        "fec0::/10",  # deprecated site-local
        "5f00::/16",  # SRv6 segment identifiers
        "2001::/32",  # Teredo
        "64:ff9b:1::/48",  # local-use NAT64
    )
]
# IPv6 prefixes whose low 32 bits name an IPv4 destination.
EMBEDDED_IPV4_NETWORKS = [
    ipaddress.ip_network(n) for n in ("::/96", "::ffff:0:0:0/96", "64:ff9b::/96")
]


def compile_path(pattern, flags=0):
    return re.compile(".*".join(re.escape(part) for part in pattern.split("*")), re.DOTALL | flags)


def deny_form(path):
    """Removes the differences that a server may ignore when it routes a path.

    A deny rule must match each spelling that reaches the denied resource, while an
    allow rule must match only the spelling that it names.
    """
    decoded = path.replace("%2F", "/").replace("%2f", "/")
    segments = [segment.split(";")[0] for segment in decoded.split("/")]
    folded = SLASHES.sub("/", "/".join(segments)).lower()
    return folded.rstrip("/") or "/"


RULES = [
    {
        "allow": rule["action"] == "allow",
        "host": rule["host"],
        "ports": set(rule["ports"]) if "ports" in rule else None,
        "methods": set(rule["methods"]) if "methods" in rule else None,
        "paths": [compile_path(p) for p in rule["paths"]] if "paths" in rule else None,
        "deny_paths": [compile_path(deny_form(p)) for p in rule["paths"]] if "paths" in rule else None,
    }
    for rule in POLICY["rules"]
]

# Client connection id -> (host, port) of its CONNECT. Rules match this target,
# because it is the only name that the agent cannot change after the tunnel opens.
TUNNEL_TARGETS = {}
# Numbers each denial, so the CLI can report denials that log rotation removed.
denial_count = 0


def log(**fields):
    if isinstance(fields.get("path"), str):
        fields["path"] = fields["path"][:LOG_PATH_CHARS]
    print(json.dumps(fields), flush=True)


def host_matches(pattern, host):
    if pattern.startswith("*."):
        return host.endswith(pattern[1:]) and len(host) > len(pattern) - 1
    return host == pattern


def port_matches(rule, port):
    return rule["ports"] is None or port in rule["ports"]


def connect_allowed(host, port):
    for rule in RULES:
        if not host_matches(rule["host"], host) or not port_matches(rule, port):
            continue
        if rule["allow"]:
            return True
        if rule["methods"] is None and rule["paths"] is None:
            return False
    return False


def decode_until_stable(value, keep_encoded_slash):
    def replace(match):
        byte = bytes([int(match.group(1), 16)])
        if keep_encoded_slash and byte == b"/":
            return b"%2F"
        return byte

    for _ in range(MAX_DECODE_ROUNDS):
        decoded = PERCENT.sub(replace, value)
        if decoded == value:
            return decoded
        value = decoded
    return None


def is_dot_segment(part):
    # Some servers trim trailing dots and spaces, so "..." and ".. " act as "..".
    name = part.split(";")[0]
    return name != "" and name.strip(" .") == ""


def canonical_path(raw):
    """Returns (path, None), or (None, reason) for a path that the policy refuses.

    An encoded slash stays encoded in the result, because a server normally
    routes it as part of one segment. The dot-segment check still treats it as a
    separator, because some servers decode before they route. The result maps each
    byte to one character, and rule patterns are ASCII.
    """
    if not raw.startswith("/"):
        return None, "path-form"
    if "#" in raw:
        return None, "path-character"
    data = raw.encode("utf-8", "surrogateescape")
    if len(data) > MAX_PATH_BYTES:
        return None, "path-length"
    segments = data.split(b"/")[1:]
    for index, segment in enumerate(segments):
        if segment == b"" and index != len(segments) - 1:
            return None, "path-empty-segment"
        decoded = decode_until_stable(segment, keep_encoded_slash=False)
        if decoded is None:
            return None, "path-encoding"
        try:
            text = unicodedata.normalize("NFKC", decoded.decode("utf-8"))
        except UnicodeDecodeError:
            # Overlong forms such as %c0%ae decode to dots on some servers.
            return None, "path-encoding"
        if PERCENT_U.search(text):
            return None, "path-encoding"
        if "\\" in text or any(ord(c) < 0x20 or ord(c) == 0x7F for c in text):
            return None, "path-character"
        if any(is_dot_segment(part) for part in text.split("/")):
            return None, "path-dot-segment"
    canonical = decode_until_stable(data, keep_encoded_slash=True)
    if canonical is None:
        return None, "path-encoding"
    return canonical.decode("latin-1"), None


def header_name(raw):
    # Some servers map "_" to "-" in header names.
    return raw.decode("latin-1").lower().replace("_", "-")


def headers_problem(req):
    for name, value in req.headers.fields:
        if not HEADER_NAME.fullmatch(name) or HEADER_VALUE_BAD.search(value):
            return "header-bytes"
        if header_name(name) in ROUTING_HEADERS:
            return "routing-header"
    return None


def has_body(req):
    if "transfer-encoding" in req.headers:
        return True
    return req.headers.get("content-length", "0").strip() != "0"


def request_tokens(req):
    tokens = []
    for name, value in req.headers.fields:
        kind = header_name(name)
        if kind not in TOKEN_HEADERS:
            continue
        text = value.decode("utf-8", "surrogateescape")
        if kind == "authorization":
            parts = text.split(None, 1)
            # Any other scheme hashes as a whole, so it never matches a stored token.
            tokens.append(parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else text)
        else:
            tokens.append(text)
    return tokens


def allowed_hashes(host):
    try:
        with open(os.path.join(CREDENTIAL_DIR, host)) as f:
            return set(f.read().split())
    except OSError:
        return set()


def credentials_ok(req, host):
    tokens = request_tokens(req)
    if not tokens:
        return True
    allowed = allowed_hashes(host)
    return all(
        hashlib.sha256(t.encode("utf-8", "surrogateescape")).hexdigest() in allowed for t in tokens
    )


def authority_host(authority):
    name = authority.rsplit("@", 1)[-1]
    if name.startswith("["):
        return name[1:].split("]", 1)[0].lower()
    return name.split(":", 1)[0].lower()


def decide(flow, host, port):
    """Returns the denial reason, or None to allow the request."""
    req = flow.request
    # mitmproxy reads the Host header only for HTTP/1 and the authority only for
    # HTTP/2, then sends both upstream. Each name must equal the checked target.
    if req.http_version not in HTTP_VERSIONS:
        return "http-version"
    if req.authority and authority_host(req.authority) != host:
        return "authority-mismatch"
    if req.pretty_host.lower() != host:
        return "host-header-mismatch"
    sni = flow.client_conn.sni
    if sni is not None and sni.lower() != host:
        return "sni-mismatch"
    problem = headers_problem(req)
    if problem:
        return problem
    # req.method is always uppercase, but upstream receives the original bytes.
    method = req.method.upper()
    if req.data.method.decode("latin-1") != method:
        return "method-form"
    # A body on these methods can smuggle a second request past a server that
    # ignores it, and it would carry data past a read-only rule.
    if method in ("GET", "HEAD") and has_body(req):
        return "body-on-get"
    path, reason = canonical_path(req.path.split("?", 1)[0])
    if reason:
        return reason
    folded = deny_form(path)
    for rule in RULES:
        if not host_matches(rule["host"], host) or not port_matches(rule, port):
            continue
        if rule["methods"] is not None and method not in rule["methods"]:
            continue
        if rule["allow"]:
            if rule["paths"] is not None and not any(p.fullmatch(path) for p in rule["paths"]):
                continue
            if host in CREDENTIAL_HOSTS and not credentials_ok(req, host):
                return "credential"
            return None
        if rule["paths"] is None:
            return "rule-deny"
        if any(p.fullmatch(path) for p in rule["paths"]) or any(
            p.fullmatch(folded) for p in rule["deny_paths"]
        ):
            return "rule-deny"
    return "no-matching-rule"


def large_or_unknown_body(req):
    if "transfer-encoding" in req.headers:
        return True
    try:
        return int(req.headers.get("content-length", "0")) > MAX_DENIED_BODY_BYTES
    except ValueError:
        return True


def deny(flow, stage, why, host, port, method=None, path=None):
    global denial_count
    denial_count += 1
    log(stage=stage, verdict="deny", why=why, seq=denial_count, method=method, host=host, port=port, path=path)
    if large_or_unknown_body(flow.request):
        flow.kill()
        return
    flow.response = http.Response.make(403, DENIED_BODY)


def http_connect(flow: http.HTTPFlow):
    # An exception in a mitmproxy hook lets the flow continue, so each hook that
    # enforces the policy turns one into a denial.
    host, port = "", 0
    try:
        host = flow.request.host.lower()
        port = flow.request.port
        if connect_allowed(host, port):
            TUNNEL_TARGETS[flow.client_conn.id] = (host, port)
            return
        why = "no-matching-rule"
    except Exception:
        why = "internal-error"
    deny(flow, "connect", why, host, port, method="CONNECT")


def requestheaders(flow: http.HTTPFlow):
    req = flow.request
    host, port = TUNNEL_TARGETS.get(flow.client_conn.id, (req.host.lower(), req.port))
    path = req.path.split("?", 1)[0]
    try:
        why = decide(flow, host, port)
    except Exception:
        why = "internal-error"
    if why:
        deny(flow, "request", why, host, port, method=req.method, path=path)
        return
    log(stage="request", verdict="allow", method=req.method, host=host, port=port, path=path)
    if host in CREDENTIAL_HOSTS:
        # A cookie can select another account in the same way a token can.
        req.headers.pop("cookie", None)
    req.stream = True


def responseheaders(flow: http.HTTPFlow):
    flow.response.stream = True


def websocket_message(flow: http.HTTPFlow):
    # mitmproxy appends each message to the flow, and a long agent session sends
    # many. mitmproxy relays the message through its own reference after this hook.
    flow.websocket.messages.clear()


def client_disconnected(client):
    TUNNEL_TARGETS.pop(client.id, None)


def is_public(address):
    ip = ipaddress.ip_address(address)
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None:
            ip = ip.sixtofour
        elif any(ip in network for network in EMBEDDED_IPV4_NETWORKS):
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if any(ip in network for network in BLOCKED_NETWORKS if network.version == ip.version):
        return False
    return ip.is_global and not ip.is_multicast


def guard_resolver(loop):
    """Makes the lookup that opens a connection refuse non-public results.

    asyncio connects to the addresses from this one lookup, so DNS rebinding has
    no second lookup to use. Replacing server.address with an IP would close the
    same gap, but mitmproxy then cannot reuse the upstream connection, and the
    sixth request in a tunnel stalls until an idle connection closes.
    """
    if getattr(loop, "ccairgap_guarded", False):
        return
    resolve = loop.getaddrinfo

    async def checked_getaddrinfo(host, port, **kwargs):
        try:
            infos = await resolve(host, port, **kwargs)
        except OSError:
            log(stage="server", verdict="deny", why="resolve-failed", host=host, port=port)
            raise
        try:
            public = len(infos) > 0 and all(is_public(info[4][0]) for info in infos)
        except Exception:
            public = False
        if not public:
            log(stage="server", verdict="deny", why="non-public-address", host=host, port=port)
            raise socket.gaierror(socket.EAI_FAIL, "ccairgap network policy: destination is not a public address")
        # The bridge network normally has no IPv6 route.
        return sorted(infos, key=lambda info: info[0] != socket.AF_INET)

    loop.getaddrinfo = checked_getaddrinfo
    loop.ccairgap_guarded = True


async def server_connect(data):
    """Refuses a non-public IP literal, which asyncio connects to with no lookup."""
    host, port = data.server.address
    try:
        guard_resolver(asyncio.get_running_loop())
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            return
        if is_public(str(literal)):
            return
    except Exception:
        pass
    log(stage="server", verdict="deny", why="non-public-address", host=host, port=port)
    data.server.error = "ccairgap network policy: destination is not a public address"


def tcp_start(flow):
    # rawtcp=false already refuses these streams. This hook is the backstop.
    log(stage="tcp", verdict="deny", why="raw-tcp")
    flow.kill()
