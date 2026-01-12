# Tweeks Sync

Export userscripts from the [Tweeks by NextByte](https://chrome.google.com/webstore/detail/tweeks-by-nextbyte/fmkancpjcacjodknfjcpmgkccbhedkhc) Chrome extension to a git repository.

## Features

- Scans all Chrome profiles for Tweeks installations
- Exports userscripts as individual `.user.js` files
- Slugified filenames from `@name` metadata
- Optional `manifest.json` tracking with sync history
- Preserves deleted scripts in the output repo

## Requirements

- Python 3.10+
- macOS (uses `strings` command for LevelDB parsing)
- Chrome must be closed when syncing (LevelDB locks)

## Installation

No external dependencies required - uses only Python standard library.

## Usage

```bash
# Sync userscripts to default location (~/Developer/tweeks-userscripts)
python tweeks_sync.py

# Sync to custom directory
python tweeks_sync.py -o /path/to/output

# List scripts without exporting
python tweeks_sync.py --list

# Sync without manifest.json
python tweeks_sync.py --no-manifest
```

## Output Structure

```
tweeks-userscripts/
├── .git/
├── .gitignore
├── README.md
├── manifest.json          # Optional sync metadata
├── reddit-remove-sidebar-expand-feed.user.js
└── other-script-name.user.js
```

## manifest.json

Tracks metadata for each script:

```json
{
  "scripts": [
    {
      "uuid": "08bc44f8-5f3d-47e3-8698-edb7b08ce1c9",
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
  "last_sync": "2025-01-12T12:00:00"
}
```

Use `--no-manifest` to disable this feature.
