# gigproxy

A tiny local caching proxy for <https://gigiau.uk>, so a kiosk browser keeps showing the site
when the PC is offline. Serves only to the same PC (binds to 127.0.0.1).

## Requirements

- Node.js 18 or later. No npm packages.
- Internet access for the first refresh (about a minute). After that it can run offline.

## Run

    node proxy.js

Then point the browser at `http://localhost:8080/`.

`start.cmd` runs it in a restart loop and logs to `proxy.log`.

## Start at logon (Windows)

From a command prompt, in this folder (adjust nothing; it uses the current path):

    schtasks /create /tn gigproxy /sc onlogon /rl limited /tr "\"%cd%\start.cmd\""

Remove with `schtasks /delete /tn gigproxy /f`. Make sure the proxy starts before the kiosk
browser (or have the browser retry), otherwise it will show a connection error at boot.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Local port |
| `REFRESH_MINUTES` | 60 | How often to refresh |
| `KEEP_CYCLES` | 3 | Images not referenced in this many successful refreshes are deleted |
| `CACHE_DIR` | `./cache` | Where cached files and `manifest.json` live |

## Behaviour

- Every refresh fetches the main page and the events JSON. If either fails, nothing is
  overwritten and the old copy keeps being served.
- On success it also fetches the CSS/JS/JSON/images the page references. An image is downloaded
  once per filename and never re-fetched.
- Images not referenced for `KEEP_CYCLES` successful refreshes are deleted.
- The location of the events JSON and show images is read from the page's script on every
  refresh (currently an S3 bucket), so it follows the site if it moves.
- The served page is patched (`location.host` -> `location.hostname`) so the site's own
  "localhost" mode works with a port number; in that mode it loads `/json/...` and `/pix/...`
  from the proxy.

## Limitations

- Enlarged pictures (tap a show) load from each promoter's own site and won't work offline.
- Detection of the data source depends on the page script keeping its current shape
  (`var platform = "..."`, `var data = {...}[platform]`, `fetch(data + "/json/events.json")`).
  If it can't be found, the last known source is kept and a warning is logged.
- If the source switches to one that reuses image filenames for different pictures, delete
  `cache/files/pix`.

## Resetting

Stop the proxy and delete the `cache` folder.
