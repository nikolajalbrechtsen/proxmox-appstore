# Proxmox App Store

A small web UI that runs in an LXC container on a Proxmox VE host (9.1 or newer).

- **My apps** - overview of all containers and VMs with start, stop, restart and delete.
- **Store** - one-click install of apps from Docker/OCI images (`catalog.json`).

No dependencies: `server.js` runs on plain Node.js 20+ and talks to the Proxmox API with an API token
that is entered on the first-run setup page. Settings are stored in `/var/lib/appstore` on the container,
never in this repository.

## Updating

The container checks this repository every minute and updates itself when `main` changes
(`autoupdate/`). So to change the app: commit and push to `main`. A commit whose `server.js`
or `catalog.json` does not parse is skipped and the running version is kept.

Check the updater on the container with `journalctl -u appstore-update -n 20`.

## Adding an app

Add an entry to `catalog.json`: `id`, `name`, `category`, `desc`, `image`, `port` (0 for no web UI),
default `cores`, `memory` (MB), `disk` (GB) and optional `env` fields. `{{hex16}}` / `{{hex64}}` in an
env value is replaced by a random string in the install dialog.
