# gigproxy

Single-file, dependency-free Node (18+) caching proxy for https://gigiau.uk, for a kiosk browser
on the same PC that must keep working offline. See README.md for user-facing docs.

## Layout
- `proxy.js` - everything: refresh loop, asset discovery, HTTP server.
- `start.cmd` - restart-loop launcher (logs to `proxy.log`).
- `cache/` - generated; `cache/files/` mirrors served URL paths, `cache/manifest.json` holds
  state (cycle counter, image last-seen cycles, discovered data source/events path/prefixes).
  Never commit or hand-edit except to reset.

## Key design points
- Local URL paths mirror the site's own "local" platform mode: `/` page, `/json/events.json`,
  `/pix/*`. `upstreamFor()` routes paths whose first segment is in `manifest.dataPrefixes` to
  the discovered data source, everything else to the site.
- The data source is parsed out of the page script each refresh (`discoverSource`), not
  hardcoded; `DEFAULT_DATA` is only a fallback. Keep it tolerant: on parse failure keep old values.
- `patchPage()` rewrites `location.host` -> `location.hostname` in the served page so the site's
  localhost mode works on a non-80 port. Applied at serve time; the cache holds the raw page.
- A refresh only counts (cycle++ and image pruning) if both the page and events JSON downloaded
  and validated. Writes are atomic (tmp + rename) so failures never clobber good copies.
- Images are immutable per filename: fetch only if missing; delete when unseen for `KEEP_CYCLES`.

## Gotchas
- Some `shows[].image` values are absolute URLs (`/pix/https://...`) that 403; they are skipped.
- Regex literals in `proxy.js` contain `\b`, `\s` etc.; when editing via shell/sed/python
  heredocs, backslashes get mangled (this already caused a bug). Use the Edit tool.
- Don't kill node by image name (`taskkill /IM node.exe`); kill by PID.

## Testing
No test suite. Manual: delete `cache/`, run `node proxy.js`, wait for `refresh: ok` in the log,
then fetch `http://localhost:8080/`, `/json/events.json` and a `/pix/...` file. For the offline
path, disconnect the network (or set a bad `dataSource` in `manifest.json` to check it is
re-discovered) and confirm cached content is still served.
