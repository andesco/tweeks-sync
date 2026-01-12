# Tweeks Sync

Export userscripts from [Tweeks by NextByte](https://chrome.google.com/webstore/detail/tweeks-by-nextbyte/fmkancpjcacjodknfjcpmgkccbhedkhc) Chrome extension to a git repository and specified folder.

## Features

- Scans all Chrome profiles for Tweeks installations
- Exports userscripts as individual `.user.js` files
- Slugified filenames from `@name` metadata
- Optional `manifest.json` tracking with update history
- Preserves deleted scripts in the output repo
- Auto-commits changes with summary (e.g., `1 added; 0 removed; 0 updated`)
- Copies scripts to a custom destination with `tweeks.` prefix

## Requirements

- Node.js 18+
- macOS

## Installation

```bash
git clone https://github.com/yourusername/tweeks-sync.git
cd tweeks-sync
```
No dependencies required.

## Usage

### npm scripts

```bash
npm start
npm run sync
npm run list # list userscripts only
npm run set
npm run set -- ~/path/to/destination
```

### CLI flags

```bash
node index.js
node index.js -o /path/to/output
node index.js -d /path/to/destination
node index.js --list
node index.js --no-manifest # do not sync metadata
node index.js --help
```

## Output Structure

```
tweeks-userscripts/
├── .git/
├── .gitignore
├── README.md
├── manifest.json # optional: syncs metadata
└── script-name.user.js
```

## Destination Directory

Optionally copy scripts to another folder with `tweeks.` prefix. For example, a synced iCloud folder for [`Userscripts`](https://github.com/quoid/userscripts)

```bash
npm run set -- ~/Library/Mobile\ Documents/com~apple~CloudDocs/Userscripts/
```

Scripts are copied as `tweeks.script-name.user.js` and only overwritten if content differs.

## Configuration

Config is stored at `~/.config/tweeks-sync/config.json`:

```json
{
  "destination": "/path/to/copy/scripts"
}
```

## manifest.json

Tracks metadata for each script (only updated when scripts change):

```json
{
  "scripts": [
    {
      "uuid": "00000000-0000-0000-0000-000000000000",
      "name": "Reddit - Remove Sidebar & Expand Feed",
      "filename": "reddit-remove-sidebar-expand-feed.user.js",
      "metadata": {
        "name": "Reddit - Remove Sidebar & Expand Feed",
        "namespace": "web.nextbyte.ai",
        "version": "1.0",
        "match": "*://www.reddit.com/*"
      },
      "synced_at": "2025-01-12T12:00:00"
    }
  ],
  "last_updated": "2025-01-12T12:00:00"
}
```

Use `--no-manifest` to disable this feature.