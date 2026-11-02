"""Small explicit forward proxy. Resolve and pin every outbound connection to a public IP.
Keep this container off the public internet: only attach its port to the internal network.
"""
import select
import socket
import socketserver
from urllib.parse import urlsplit

from app.security import DNSResolutionError, UnsafeURL, public_addresses, validate_url


def connect_public(host, port):
    # Validate ALL DNS answers, then connect to the numeric address (no second DNS lookup).
    addresses = public_addresses(host, port)
    failure = None
    for address in addresses:
        family = socket.AF_INET6 if ':' in address else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(20)
        try:
            sock.connect((address, port))
            return sock
        except OSError as exc:
            failure = exc
            sock.close()
    raise failure or OSError('Connection failed')


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = None
        response_started = False
        try:
            self.request.settimeout(20)
            initial = b''
            while b'\r\n\r\n' not in initial:
                chunk = self.request.recv(4096)
                if not chunk or len(initial) > 32768:
                    raise UnsafeURL('Invalid request')
                initial += chunk
            header, body = initial.split(b'\r\n\r\n', 1)
            lines = header.decode('iso-8859-1').split('\r\n')
            method, target, version = lines[0].split(' ', 2)
            if method == 'CONNECT':
                parsed = urlsplit('https://' + target)
                if not parsed.hostname or parsed.port != 443 or parsed.path or parsed.username:
                    raise UnsafeURL('Invalid tunnel')
                upstream = connect_public(parsed.hostname, 443)
                self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                response_started = True
                if body:
                    upstream.sendall(body)
            else:
                url = validate_url(target, resolve=False)
                parsed = urlsplit(url)
                if parsed.scheme != 'http' or method not in {'GET', 'HEAD', 'POST'}:
                    raise UnsafeURL('Unsupported method')
                upstream = connect_public(parsed.hostname, 80)
                path = parsed.path + ('?' + parsed.query if parsed.query else '')
                forwarded = [f'{method} {path} HTTP/1.1', f'Host: {parsed.netloc}', 'Connection: close']
                for line in lines[1:]:
                    if ':' not in line:
                        raise UnsafeURL('Invalid header')
                    if line.split(':', 1)[0].lower() not in {'host', 'connection', 'proxy-connection', 'proxy-authorization'}:
                        forwarded.append(line)
                upstream.sendall(('\r\n'.join(forwarded) + '\r\n\r\n').encode('iso-8859-1') + body)
            peers = [self.request, upstream]
            while True:
                ready, _, _ = select.select(peers, [], [], 60)
                if not ready:
                    break
                for peer in ready:
                    chunk = peer.recv(65536)
                    if not chunk:
                        return
                    if peer is upstream:
                        response_started = True
                    (upstream if peer is self.request else self.request).sendall(chunk)
        except Exception as exc:
            if not response_started:
                status, code = '502 Bad Gateway', 'UPSTREAM_UNAVAILABLE'
                if isinstance(exc, DNSResolutionError):
                    code = 'DNS_RESOLUTION_FAILED'
                elif isinstance(exc, (UnsafeURL, ValueError, UnicodeError)):
                    status, code = '403 Forbidden', 'TARGET_REJECTED'
                try:
                    self.request.sendall((
                        f'HTTP/1.1 {status}\r\nContent-Length: 0\r\n'
                        f'X-VideoFlow-Egress-Error: {code}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'
                    ).encode('ascii'))
                except OSError:
                    pass
        finally:
            if upstream:
                upstream.close()


class Proxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64


if __name__ == '__main__':
    with Proxy(('0.0.0.0', 8080), Handler) as server:
        server.serve_forever()
