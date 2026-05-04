# Remote access

The dashboard binds to `localhost` by default, which is fine until you want
to triage jobs from your phone, your other laptop, or a different network.
This guide walks two free paths to get there: **Tailscale** (a private mesh
VPN, recommended for solo use) and **Cloudflare Tunnel + Cloudflare Access**
(a clean public URL fronted by an auth gate). A third option — running the
whole stack on a small VPS — is sketched at the end.

> [!WARNING]
> The dashboard ships with **zero local authentication**. Anyone who can
> reach `:5173` can read your CV, your scoring history, your recruiter
> notes, and your full application pipeline. Tailscale is safe by default
> because only your own devices can reach the tailnet. Public exposure
> (Cloudflare Tunnel, ngrok, port-forward on your home router, etc.)
> without an auth gate puts all of that on the open internet. Always
> deploy public access behind Cloudflare Access or an equivalent
> identity check.

## Pick a path

| | Tailscale | Cloudflare Tunnel + Access | Cloud VPS |
| --- | --- | --- | --- |
| **Setup time** | 5–10 min | 20–40 min | 1–3 hours |
| **URL shape** | `http://your-mac.tail-scale.ts.net:5173` (tailnet name varies) | `https://jobs.your-domain.com` (or random `*.trycloudflare.com` for testing) | `https://your-host.example.com` |
| **Auth model** | Implicit — only your tailnet devices can resolve / reach the host | Explicit — Cloudflare Access gate (Google login or magic-link OTP) | Whatever you build |
| **Can share with someone else** | Yes, if you invite them to your tailnet | Yes, by adding their email to the Access policy | Yes |
| **Trust dependency** | Tailscale handles discovery; traffic is end-to-end WireGuard | Cloudflare terminates HTTPS at their edge | Your VPS provider |
| **Mac-must-be-awake** | Yes | Yes | No (whole stack runs on the VPS) |
| **Pick this when** | You want the simplest possible private access for your own devices | You want a clean shareable URL with real login | You don't want your laptop in the loop |

Most readers want **Tailscale**. Skip down to "Path B" only if you
specifically need a shareable HTTPS URL.

## Before either path: let Vite listen on the network

Vite's dev server binds to `localhost` by default, which means even a
tunnel pointing at `localhost:5173` won't reach it from the right
network namespace. Bind it to all interfaces by either:

- starting the dev server with the `--host` flag:

  ```bash
  cd ui
  npm run dev -- --host
  ```

  On startup you should now see two URLs printed, e.g.:

  ```
    Local:   http://localhost:5173/
    Network: http://192.168.1.42:5173/
  ```

  The `Network:` line confirms Vite is reachable from off-host (Vite
  prints both lines once `--host` is set; the leading arrow glyph is
  omitted here for plain-text portability).

- or, if you want this to be the default, edit `ui/vite.config.ts` and
  add a `server` block at the top level of the exported config:

  ```ts
  export default defineConfig({
    server: { host: true },
    // ...rest of your config
  });
  ```

Either is fine. The `--host` flag is non-invasive (no committed change);
the config edit is sticky across restarts but it's a small local diff
on top of the upstream repo.

## Path A — Tailscale (recommended)

Tailscale is a mesh VPN built on WireGuard. You install a small daemon
on every device you own; they discover each other through Tailscale's
coordination service and then talk directly, peer-to-peer, over an
encrypted tunnel. From the dashboard's perspective, your phone looks
like another machine on the same LAN. Free for personal use up to 100
devices and 3 users — no credit card.

### Setup

1. **Sign up** at <https://tailscale.com>. OAuth via Google, GitHub,
   Microsoft, or Apple — no card, no email confirmation dance.

2. **Install on the machine running the dashboard.** The package
   command varies by OS; the `tailscale up` step that follows is the
   same everywhere. The CLI prints a one-time login URL the first time
   you run `tailscale up`.

   - **macOS:**
     ```bash
     brew install tailscale
     sudo tailscale up
     ```
     Or download the menu-bar app from <https://tailscale.com/download>
     for a GUI that handles login for you.
   - **Linux:**
     ```bash
     curl -fsSL https://tailscale.com/install.sh | sh
     sudo tailscale up
     # or your distro package manager:
     # sudo apt install tailscale       # Debian / Ubuntu
     # sudo dnf install tailscale       # Fedora / RHEL
     ```
   - **Windows:**
     ```powershell
     winget install --id Tailscale.Tailscale
     tailscale up
     ```
     Or download the installer at <https://tailscale.com/download/windows>.

3. **Install on your phone.** Tailscale app from the App Store
   (iOS) or Play Store (Android). Sign in with the same account.
   Toggle the VPN on.

4. **Repeat for any other device you want in the loop.** Linux,
   Windows, Apple TV, a NAS, a Raspberry Pi — full client list at
   <https://tailscale.com/download>. Same account, same tailnet.

5. **Find your Mac's tailnet hostname.** Open the Tailscale admin
   console at <https://login.tailscale.com/admin/machines>. You'll
   see your Mac listed with a name like `eliran-mac` and a MagicDNS
   address like `eliran-mac.tail-scale.ts.net` (the suffix is your
   tailnet's, generated at signup; replace it with whatever yours is).

6. **Start the dashboard with `--host`** (see the Vite section above)
   so it listens on all interfaces, not just `localhost`.

7. **Hit it from your phone.** With Tailscale toggled on, open
   `http://eliran-mac.tail-scale.ts.net:5173` in mobile Safari.
   Bookmark it. Add to home screen if you want a fake-app shortcut.

> [!NOTE]
> If MagicDNS isn't enabled in your tailnet (it is by default for
> new accounts), you can use the raw 100.x.x.x tailnet IP shown in
> the admin console instead — `http://100.64.1.5:5173` works just as
> well.

### Caveats

> [!NOTE]
> **Your Mac must be awake** for any of this to work. Tailscale only
> brokers the connection — it doesn't run the dashboard. If the Mac
> sleeps, the dashboard goes with it. Either disable sleep when on AC
> power (System Settings → Battery → Power Adapter → Prevent
> automatic sleeping when the display is off), or run the dev server
> as a launchd job that survives sleep. The launchd setup is out of
> scope here.

> [!NOTE]
> **Trust dependency.** Tailscale's coordination server learns which
> nodes belong to your tailnet and helps them find each other (NAT
> traversal). It does **not** see the traffic itself — that's
> end-to-end encrypted with WireGuard between your devices. If you
> want to remove even the discovery dependency, Tailscale supports
> self-hosting the coordination server via Headscale, but that's a
> different rabbit hole.

### When Tailscale is wrong for you

- You want to send a URL to someone who isn't going to install a
  Tailscale client. (You can invite users to your tailnet for free,
  but they still need the client.)
- You want to bookmark a clean `https://` URL in mobile Safari with
  no VPN toggle. Tailscale always means "VPN on" when you want to
  reach the dashboard.

For either of those, see Path B.

## Path B — Cloudflare Tunnel + Cloudflare Access

Cloudflare Tunnel runs a small daemon (`cloudflared`) on your Mac
that opens a persistent outbound connection to Cloudflare's edge.
Inbound requests to your hostname hit Cloudflare first, then get
proxied through that tunnel back to `localhost:5173`. **No inbound
ports open on your home router. No public IP needed.** Cloudflare
Access then sits in front of the tunnel as an identity gate — Google
login, GitHub login, or magic-link OTP to a whitelisted email.

Both products are free for personal use (Access is free for the
first 50 users on the Zero Trust plan). The only thing that costs
money is owning a real domain — typically $10/yr through any
registrar — and even that you can skip for testing.

### Setup

Cloudflare's UI moves around. The names of the menu items below were
current at the time of writing; if something has shifted, search the
Zero Trust dashboard for "Tunnels" and "Access > Applications" — the
flow is the same.

1. **Sign up** at <https://cloudflare.com>. Free tier, no card.

2. **Get a domain into Cloudflare.** Three options:

   - **You already own one.** Add it as a site in Cloudflare and
     switch its nameservers to the two Cloudflare gives you. DNS
     management is free; the tunnel rides on top.
   - **Buy a fresh one.** Cloudflare Registrar sells at cost
     (around $10/yr for `.com`). Any other registrar works too.
   - **Skip the domain entirely** and use a one-shot
     `*.trycloudflare.com` URL. Fine for poking around; the
     subdomain rotates on every restart, and you cannot put
     Cloudflare Access in front of it. **Don't use it for anything
     real.**

3. **Create the tunnel.** In the Cloudflare dashboard:
   **Zero Trust → Networks → Tunnels → Create a tunnel**. Pick
   "Cloudflared" as the connector type. Give it a name
   (`linkedin-jobs-mac` works).

4. **Install `cloudflared` on the machine running the dashboard.** The
   Cloudflare dashboard hands you a baked-in token to pass to
   `cloudflared service install` after the package is on disk; the
   package install step itself varies by OS:

   - **macOS:**
     ```bash
     brew install cloudflared
     sudo cloudflared service install eyJhIjoi...    # token from the dashboard
     ```
   - **Linux (Debian / Ubuntu, amd64):**
     ```bash
     curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
     sudo dpkg -i cloudflared.deb
     sudo cloudflared service install eyJhIjoi...    # token from the dashboard
     ```
     For other distros / arm64, grab the matching artifact from
     <https://github.com/cloudflare/cloudflared/releases>.
   - **Windows:**
     ```powershell
     winget install --id Cloudflare.cloudflared
     cloudflared service install eyJhIjoi...    # token from the dashboard
     ```
     Or download the .msi from
     <https://github.com/cloudflare/cloudflared/releases>.

   Run it. The tunnel will appear as **HEALTHY** in the Cloudflare
   dashboard within ~30 seconds. If it doesn't, check `cloudflared`
   logs (macOS: `/Library/Logs/com.cloudflare.cloudflared.err.log`;
   Linux: `journalctl -u cloudflared`; Windows: Event Viewer).

5. **Map the tunnel to a hostname.** Still in the tunnel's config
   page, **Public Hostname → Add a public hostname**:

   - **Subdomain**: `jobs` (or whatever)
   - **Domain**: pick yours from the dropdown
   - **Service type**: `HTTP`
   - **URL**: `localhost:5173`

   Save. Cloudflare automatically creates the matching DNS record.

6. **Start the dashboard with `--host`** (see the Vite section above).

7. **Add Cloudflare Access in front of it.** This is the auth gate.
   Skipping this step means anyone on the internet who finds the
   hostname loads your dashboard.

   **Zero Trust → Access → Applications → Add an application →
   Self-hosted**:

   - **Application name**: `linkedin-jobs`
   - **Application domain**: `jobs.your-domain.com` (must match the
     tunnel hostname exactly)
   - **Identity provider**: leave the default (one-time PIN by email
     works without any extra setup; Google / GitHub need an OAuth
     app).

   Then **Add a policy**:

   - **Policy name**: `me-only`
   - **Action**: `Allow`
   - **Selector**: `Emails` → `your.email@example.com`

   Save. Cloudflare will now intercept every request to
   `jobs.your-domain.com` and demand a login first.

8. **Test from your phone.** Open `https://jobs.your-domain.com` in
   mobile Safari. You should see Cloudflare's login page first,
   then — after authenticating — the dashboard.

### Caveats

> [!WARNING]
> **Your Mac must be awake.** `cloudflared` is a process on your Mac;
> it can't tunnel anything if the Mac is asleep. Phone hits will
> show a Cloudflare error page (typically 502 Bad Gateway) until the
> Mac wakes and `cloudflared` reconnects. Either disable sleep on
> AC, or install `cloudflared` as a launchd LaunchDaemon (the
> `cloudflared service install` command above already does this if
> you ran it with `sudo` — verify with `sudo launchctl list | grep
> cloudflared`).

> [!WARNING]
> **Trust dependency.** Cloudflare terminates HTTPS at their edge
> and re-encrypts to your Mac over the tunnel. They could in theory
> read or modify your traffic. They are a serious operator with a
> clean track record, but it is a real placement of trust — every
> packet between your phone and the dashboard goes through them in
> cleartext (relative to Cloudflare). If your data is sensitive
> enough that this matters, use Tailscale instead; it's
> end-to-end-encrypted between your devices.

> [!WARNING]
> **Cloudflare Access is not optional.** With Access off, your
> hostname is a public URL with no login screen. The dashboard does
> not authenticate anyone. Always-on for any non-`trycloudflare.com`
> hostname.

> [!NOTE]
> **You get DDoS / bot protection for free.** Cloudflare's edge sits
> between your tunnel and the internet, so you inherit their L7
> filtering and rate limiting at no charge. Small silver lining.

### When Cloudflare is wrong for you

- You don't have a domain and don't want one. (`trycloudflare.com`
  works but can't have Access in front of it, so it's not safe for
  the dashboard.)
- You don't want to depend on a third party for the auth gate.
- The Mac-must-be-awake constraint is a non-starter — you want
  scrapes and the dashboard to be reachable while your laptop is in
  a bag. In that case you need a real always-on host; see Path C.

## Path C — Cloud VPS (sketch)

If "Mac doesn't need to be on" is a hard requirement, you'll want
the whole stack — scraper, Python control surfaces, the React dev
server — running on a small always-on host. A $5/mo box on Hetzner,
DigitalOcean, Fly.io, or Railway is plenty.

This is meaningfully heavier than Path A or B:

- You provision the server, install Python and Node, run Playwright
  in a headless-capable environment (`playwright install
  --with-deps`), and keep the dev server alive with `systemd` or a
  process manager.
- The scraper still needs your LinkedIn session for `loggedin` mode.
  You either log in once on the VPS through a remote browser
  session, or you sync `linkedin_session.json` from your local Mac
  on a schedule.
- Your CV, ratings, recruiter notes, and full application history
  now live on a third-party server. That's a meaningfully different
  data-residency story from Paths A and B, where the data never
  leaves your Mac.

Cloud-host deployment is **not covered in detail in this guide.**
It's tracked as roadmap item #91 (FastAPI deploy) and will get a
proper walkthrough then.

## A note on the auth model

The dashboard has **no local authentication, by design.** It assumes
the only thing on the other end of `localhost:5173` is you. That
assumption holds for:

- Tailscale (only your devices can reach the host),
- Cloudflare Tunnel **with** Cloudflare Access (CF terminates the
  request and only forwards if the user passed the policy),
- a VPS where you've put your own auth in front (out of scope).

That assumption breaks for:

- Cloudflare Tunnel **without** Access,
- ngrok / serveo / any quick tunnel pointed at `localhost:5173` with
  no gate,
- a port-forward through your home router (`*.dyndns.org:5173`).

If you find yourself about to do any of the second list, stop and
add a gate first. Cloudflare Access takes about ten minutes to set
up and is free, which is faster than recovering from your CV being
indexed by a search engine.
