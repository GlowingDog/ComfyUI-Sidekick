"""Outbound HTTP for things the MODEL asks for (web pages, search, model files).

It never reaches loopback, private, link-local or otherwise non-public addresses: a
web page or a prompt injection must not be able to read this machine's or the LAN's
services through Sidekick. The check happens where the connection is made (a resolver
that refuses non-public answers), so DNS rebinding cannot slip between check and use,
and every redirect hop is checked again because redirects are followed by hand."""
import ipaddress
from contextlib import asynccontextmanager
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import DefaultResolver

MAX_REDIRECTS = 5
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp")
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class Blocked(Exception):
    """The URL (or where it leads) is not allowed."""


def is_public_ip(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    if ip.version == 6:  # addresses that smuggle an IPv4 address inside
        inner = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if inner is None and ip in _NAT64:
            inner = ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
        if inner is not None:
            ip = inner
    # is_global is False for private, loopback, link-local, reserved, shared (100.64/10), unspecified
    return bool(ip.is_global) and not ip.is_multicast


def check_url(url):
    """Validate scheme and host of one hop. Returns the split URL or raises Blocked."""
    try:
        parts = urlsplit(str(url).strip())
        host = parts.hostname
        parts.port  # raises ValueError on a bad port
    except ValueError:
        raise Blocked("That is not a valid URL.")
    if parts.scheme not in ("http", "https"):
        raise Blocked("Only http:// and https:// URLs are allowed.")
    if parts.username or parts.password:
        raise Blocked("URLs with embedded credentials are not allowed.")
    if not host:
        raise Blocked("The URL has no host.")
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    if literal:
        if not is_public_ip(host):
            raise Blocked(f"{host} is not a public internet address.")
    elif host == "localhost" or "." not in host or host.endswith(_LOCAL_SUFFIXES):
        raise Blocked(f"{host} is a local network name, not a public internet host.")
    return parts


class PublicOnlyResolver(AbstractResolver):
    """DNS answers that include any non-public address are refused as a whole."""

    def __init__(self):
        self._inner = DefaultResolver()

    async def resolve(self, host, port=0, family=0):
        infos = await self._inner.resolve(host, port, family)
        bad = [i["host"] for i in infos if not is_public_ip(i["host"])]
        if bad or not infos:
            raise OSError(f"{host} resolves to a non-public address ({bad[0] if bad else 'nothing'}); blocked")
        return infos

    async def close(self):
        await self._inner.close()


def _auth_for(host, auth):
    """auth: {host_suffix: {header: value}} — credentials only ever go to their own host."""
    for suffix, headers in (auth or {}).items():
        if host == suffix or host.endswith("." + suffix):
            return headers
    return {}


@asynccontextmanager
async def open_url(url, *, method="GET", headers=None, auth=None, json_body=None, data=None,
                   timeout=30, guard=True, sock_read=None):
    """Yield (response, final_url). Redirects are followed by hand so each hop is checked
    and so credentials are not carried to another host."""
    connector = aiohttp.TCPConnector(resolver=PublicOnlyResolver()) if guard else aiohttp.TCPConnector()
    client_timeout = aiohttp.ClientTimeout(total=timeout, sock_connect=20, sock_read=sock_read)
    async with aiohttp.ClientSession(connector=connector, timeout=client_timeout, trust_env=False) as http:
        for _ in range(MAX_REDIRECTS + 1):
            parts = check_url(url) if guard else urlsplit(url)
            hop = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.8"}
            hop.update(headers or {})
            hop.update(_auth_for(parts.hostname or "", auth))
            try:
                resp = await http.request(method, url, headers=hop, json=json_body, data=data,
                                          allow_redirects=False)
            except aiohttp.ClientConnectorError as e:
                if "blocked" in str(e.os_error or e):
                    raise Blocked(str(e.os_error or e))
                raise
            if resp.status in (301, 302, 303, 307, 308) and resp.headers.get("Location"):
                target = urljoin(url, resp.headers["Location"])
                if resp.status == 303 or (resp.status in (301, 302) and method == "POST"):
                    method, json_body, data = "GET", None, None
                resp.release()
                url = target
                continue
            try:
                yield resp, url
            finally:
                resp.release()
            return
        raise Blocked(f"More than {MAX_REDIRECTS} redirects.")


async def fetch(url, *, max_bytes=2_000_000, **kw):
    """GET/POST a small document. Returns (final_url, status, headers, body_bytes, truncated)."""
    async with open_url(url, **kw) as (resp, final_url):
        chunks, size, truncated = [], 0, False
        async for chunk in resp.content.iter_chunked(65536):
            chunks.append(chunk)
            size += len(chunk)
            if size >= max_bytes:
                truncated = True
                break
        return final_url, resp.status, resp.headers, b"".join(chunks)[:max_bytes], truncated
