# MediaChat

## Start

Install dependencies with `npm install`, copy `.env.example` to `.env`, configure the values you need, then run `npm start`. The server loads `.env` automatically and defaults to `http://127.0.0.1:3000`.

## Submission CAPTCHA

Uploads and comments require Cloudflare Turnstile verification. Create a Turnstile widget for the hostnames where the app will run, then configure both keys before starting the server:

```sh
TURNSTILE_SITE_KEY=your-public-site-key
TURNSTILE_SECRET_KEY=your-server-secret-key
```

The site key is rendered into the page; the secret is used only by the server to verify one-time tokens with Cloudflare. Keep the secret out of source control and client code. Upload and comment widgets use separate Turnstile actions, which are checked again by the server. If either key is missing, uploads and comments return HTTP 503 and remain disabled; if verification is unavailable or the action does not match, the server fails closed. The Turnstile script must be reachable from the browser.

## Google AdSense

After your site is approved in AdSense, set `ADSENSE_PUBLISHER_ID` to the publisher ID shown in your account, in the format `ca-pub-1234567890123456`, then restart the server. The page will load Google's AdSense script and serve the corresponding seller declaration at `/ads.txt`. Enable Auto ads in AdSense to control ad placement; fixed ad units require their own account-generated slot IDs and are not included by default. Ad serving also depends on Google's site review and consent requirements for your audience and region.

## Content audit log

Successful media uploads and posted comments are recorded as JSON Lines in `converted/audit/content-events.jsonl` (or under `AUDIT_DIRECTORY`). Each record contains a UTC timestamp and IP address. Upload events also include the media ID, type, category, original filename, and byte count. Comment events include the media ID, comment ID, and comment text. The audit directory is restricted to owner access and the log file to owner read/write access on POSIX systems.

These records contain personal data. Disclose IP and comment logging to users, restrict access to the server and its backups, and set a retention/rotation policy appropriate to your jurisdiction. The app does not automatically expire audit records.

By default, the recorded IP is the direct TCP peer (`request.socket.remoteAddress`). If the server is behind a reverse proxy, set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops so the server can read the corresponding `X-Forwarded-For` entry. Only enable this when untrusted clients cannot bypass the proxy and connect directly.

Each media item accepts one vote per client IP. The vote file stores keyed hashes of IP addresses, not raw addresses; the persistent HMAC key is kept in `converted/.vote-hash-secret` with owner-only permissions. Preserve that file across restarts so previous votes remain recognizable. If the key is lost or replaced, existing scores remain, but prior voters can vote again.

## VPN and Tor screening

The server can block requests whose IP is classified by MaxMind as an anonymous VPN, Tor exit node, or public proxy. Obtain the MaxMind GeoIP2 Anonymous IP database under its current license and keep the database updated. Then configure:

```sh
MAXMIND_ANONYMOUS_IP_DB=/absolute/path/to/GeoIP2-Anonymous-IP.mmdb
BLOCK_ANONYMOUS_IPS=true
```

When enabled, a missing or invalid database prevents server startup, and lookup errors fail closed with HTTP 503. Without `BLOCK_ANONYMOUS_IPS=true`, screening is disabled and the server prints a warning. The database only blocks addresses MaxMind identifies; no IP intelligence database can guarantee detection of every VPN, proxy, or Tor-related address. Keep it current and combine it with operational monitoring if stricter access control is required.