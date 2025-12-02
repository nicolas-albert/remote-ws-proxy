# Docker usage

Image `remote-ws-proxy` supports all roles via env vars (no prefix required; RWP_* still supported).

## Common env
- `ROLE`: `server` | `lan` | `proxy` (default `server`)
- `TRANSPORT`: `auto` | `ws` | `http` (default `auto`)
- `INSECURE`: `true/false` — disable TLS verification
- `DEBUG`: `true/false` — verbose HTTP debug

## Server
```
docker run -p 8080:8080 \
  -e ROLE=server \
  -e PORT=8080 -e HOST=0.0.0.0 \
  <img>
```

## LAN
- `SERVER_URL`: full URL; session can be included in the path (`.../<session>`)
- or `SERVER` + `SESSION` separately.
- `PROXY`: outbound proxy to reach the server
- `TUNNEL_PROXY`: proxy for TCP CONNECT targets (use `true` to reuse `PROXY`)
```
docker run --net host \
  -e ROLE=lan \
  -e SERVER_URL=https://rwp.endpoint.example.com/mys \
  -e TRANSPORT=http \
  -e PROXY=http://proxy:3128 \
  -e TUNNEL_PROXY=true \
  -e INSECURE=true \
  <img>
```

## Proxy
- `SERVER_URL` or `SERVER`+`SESSION` same rules as LAN
- `PROXY`: outbound proxy to reach the server
- `PROXY_PORT` (default 3128), `PROXY_HOST` (default 0.0.0.0)
```
docker run -p 3128:3128 \
  -e ROLE=proxy \
  -e SERVER_URL=https://rwp.endpoint.example.com/mys \
  -e TRANSPORT=ws \
  -e PROXY=http://proxy:3128 \
  -e INSECURE=true \
  <img>
```

## Notes
- Longpoll HTTP transport is supported; WS remains preferred when available.
- Image tag: `<dockerhub_user>/remote-ws-proxy:<tag>` or `latest`.
