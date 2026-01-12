#!/usr/bin/env python3
"""
Tweeks Sync - Export userscripts from Tweeks by NextByte Chrome extension.

This tool scans all Chrome profiles for the Tweeks extension and exports
userscripts to a git repository.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional



TWEEKS_EXTENSION_ID = "fmkancpjcacjodknfjcpmgkccbhedkhc"
CHROME_SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
DEFAULT_OUTPUT_DIR = Path.home() / "Developer" / "tweeks-userscripts"
CONFIG_FILE = Path.home() / ".config" / "tweeks-sync" / "config.json"


def load_config() -> dict:
    """Load configuration from config file."""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_config(config: dict):
    """Save configuration to config file."""
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)


def get_destination_dir(dest_flag: Optional[Path] = None) -> Optional[Path]:
    """Get destination directory from flag, config, or prompt user on first run."""
    config = load_config()
    
    if dest_flag:
        config['destination'] = str(dest_flag)
        save_config(config)
        return dest_flag
    
    if 'destination' in config:
        if config['destination'] is None:
            return None
        return Path(config['destination'])
    
    print("\n📁 Optional: Set a destination directory to copy userscripts to.")
    print("   Scripts will be copied with 'tweeks.' prefix (e.g., tweeks.script-name.user.js)")
    print("   Press Enter to skip, or enter a path:\n")
    
    response = input("Destination directory: ").strip()
    
    if response:
        dest = Path(response).expanduser()
        config['destination'] = str(dest)
        save_config(config)
        print(f"Saved destination: {dest}")
        return dest
    
    config['destination'] = None
    save_config(config)
    return None


def copy_to_destination(output_dir: Path, dest_dir: Path):
    """Copy userscripts to destination directory with 'tweeks.' prefix."""
    if not dest_dir:
        return
    
    dest_dir = Path(dest_dir).expanduser()
    dest_dir.mkdir(parents=True, exist_ok=True)
    
    import shutil
    added = 0
    skipped = 0
    overwritten = 0
    
    for script_file in output_dir.glob("*.user.js"):
        dest_filename = f"tweeks.{script_file.name}"
        dest_path = dest_dir / dest_filename
        
        if dest_path.exists():
            with open(script_file, 'r') as f:
                source_content = f.read()
            with open(dest_path, 'r') as f:
                dest_content = f.read()
            if source_content == dest_content:
                skipped += 1
                continue
            shutil.copy2(script_file, dest_path)
            overwritten += 1
        else:
            shutil.copy2(script_file, dest_path)
            added += 1
    
    print(f"Destination: {added} added; {skipped} skipped; {overwritten} overwritten")


def is_chrome_running() -> bool:
    """Check if Google Chrome is currently running."""
    result = subprocess.run(
        ["pgrep", "-x", "Google Chrome"],
        capture_output=True
    )
    return result.returncode == 0


def quit_chrome() -> bool:
    """Attempt to gracefully quit Chrome using AppleScript."""
    result = subprocess.run(
        ["osascript", "-e", 'tell application "Google Chrome" to quit'],
        capture_output=True
    )
    return result.returncode == 0


def ensure_chrome_closed() -> bool:
    """Check if Chrome is running and prompt user to close it."""
    if not is_chrome_running():
        return True
    
    print("⚠️  Google Chrome is running.")
    print("Chrome must be closed to read the userscript database (LevelDB lock).")
    print()
    
    while True:
        response = input("Quit Chrome now? [Y/n/manual]: ").strip().lower()
        
        if response in ('', 'y', 'yes'):
            print("Quitting Chrome...")
            if quit_chrome():
                import time
                for _ in range(10):
                    time.sleep(0.5)
                    if not is_chrome_running():
                        print("Chrome closed successfully.")
                        return True
                print("Chrome is still running. Please close it manually.")
                return False
            else:
                print("Failed to quit Chrome. Please close it manually.")
                return False
        
        elif response in ('n', 'no'):
            print("Cannot proceed while Chrome is running.")
            return False
        
        elif response == 'manual':
            print("Please close Chrome manually, then press Enter...")
            input()
            if not is_chrome_running():
                return True
            print("Chrome is still running.")
        
        else:
            print("Please enter 'y' (quit), 'n' (cancel), or 'manual'.")


def slugify(text: str) -> str:
    """Convert text to a slug suitable for filenames."""
    text = text.lower()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[-\s]+', '-', text)
    return text.strip('-')


def parse_userscript_metadata(script: str) -> dict:
    """Extract metadata from userscript header."""
    metadata = {}
    
    match = re.search(r'//\s*==UserScript==(.*?)//\s*==/UserScript==', script, re.DOTALL)
    if not match:
        return metadata
    
    header = match.group(1)
    for line in header.split('\n'):
        line = line.strip()
        if line.startswith('//'):
            line = line[2:].strip()
            match = re.match(r'@(\w+)\s+(.*)', line)
            if match:
                key, value = match.groups()
                if key in metadata:
                    if isinstance(metadata[key], list):
                        metadata[key].append(value)
                    else:
                        metadata[key] = [metadata[key], value]
                else:
                    metadata[key] = value
    
    return metadata


def find_tweeks_databases() -> list[Path]:
    """Find all Tweeks extension LevelDB databases across Chrome profiles."""
    databases = []
    
    if not CHROME_SUPPORT_DIR.exists():
        print(f"Chrome support directory not found: {CHROME_SUPPORT_DIR}")
        return databases
    
    for profile_dir in CHROME_SUPPORT_DIR.iterdir():
        if not profile_dir.is_dir():
            continue
        
        if not (profile_dir.name.startswith("Profile") or profile_dir.name == "Default"):
            continue
        
        extension_settings = profile_dir / "Local Extension Settings" / TWEEKS_EXTENSION_ID
        if extension_settings.exists():
            databases.append(extension_settings)
            print(f"Found Tweeks database in: {profile_dir.name}")
    
    return databases


def verify_tweeks_extension(profile_dir: Path) -> bool:
    """Verify that the extension is indeed Tweeks by NextByte."""
    extensions_dir = profile_dir / "Extensions" / TWEEKS_EXTENSION_ID
    if not extensions_dir.exists():
        return False
    
    for version_dir in extensions_dir.iterdir():
        if version_dir.is_dir():
            manifest_path = version_dir / "manifest.json"
            if manifest_path.exists():
                try:
                    with open(manifest_path) as f:
                        manifest = json.load(f)
                    if "Tweeks" in manifest.get("name", ""):
                        return True
                except (json.JSONDecodeError, IOError):
                    pass
    
    return False


def extract_userscripts(db_path: Path) -> dict[str, str]:
    """Extract userscripts from a LevelDB database by parsing log files directly."""
    scripts = {}
    
    def parse_scripts_from_text(text: str) -> dict[str, str]:
        """Parse userscripts from text content."""
        found = {}
        
        idx = 0
        while True:
            start = text.find('{"', idx)
            if start == -1:
                break
            
            if '==UserScript==' not in text[start:start+5000]:
                idx = start + 1
                continue
            
            brace_count = 0
            end = start
            in_string = False
            escape_next = False
            
            for i, c in enumerate(text[start:], start):
                if escape_next:
                    escape_next = False
                    continue
                
                if c == '\\':
                    escape_next = True
                    continue
                
                if c == '"' and not escape_next:
                    in_string = not in_string
                    continue
                
                if in_string:
                    continue
                
                if c == '{':
                    brace_count += 1
                elif c == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        end = i + 1
                        break
            
            if end > start:
                json_str = text[start:end]
                try:
                    data = json.loads(json_str)
                    if isinstance(data, dict):
                        for uuid, script in data.items():
                            if isinstance(script, str) and '==UserScript==' in script:
                                found[uuid] = script
                except json.JSONDecodeError:
                    pass
                idx = end
            else:
                idx = start + 1
        
        return found
    
    for log_file in db_path.glob("*.log"):
        try:
            with open(log_file, 'rb') as f:
                content = f.read()
            text = content.decode('utf-8', errors='ignore')
            scripts.update(parse_scripts_from_text(text))
        except (IOError, OSError) as e:
            print(f"  Warning: Could not read {log_file}: {e}")
            continue
    
    if not scripts:
        for ldb_file in db_path.glob("*.ldb"):
            try:
                result = subprocess.run(
                    ['strings', str(ldb_file)],
                    capture_output=True,
                    text=True
                )
                scripts.update(parse_scripts_from_text(result.stdout))
            except Exception as e:
                print(f"  Warning: Could not read {ldb_file}: {e}")
                continue
    
    return scripts


def export_userscripts(
    scripts: dict[str, str],
    output_dir: Path,
    include_manifest: bool = True
) -> tuple[list[dict], int, int, int]:
    """Export userscripts to files and optionally update manifest.
    
    Returns: (exported_list, added_count, updated_count, removed_count)
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    
    exported = []
    added = 0
    updated = 0
    
    for uuid, script in scripts.items():
        metadata = parse_userscript_metadata(script)
        name = metadata.get('name', uuid)
        slug = slugify(name)
        filename = f"{slug}.user.js"
        filepath = output_dir / filename
        
        is_new = not filepath.exists()
        content_changed = False
        
        if not is_new:
            with open(filepath, 'r') as f:
                existing_content = f.read()
            content_changed = existing_content != script
        
        if is_new or content_changed:
            with open(filepath, 'w') as f:
                f.write(script)
            
            if is_new:
                added += 1
                print(f"  Added: {filename}")
            else:
                updated += 1
                print(f"  Updated: {filename}")
        else:
            print(f"  Unchanged: {filename}")
        
        exported.append({
            'uuid': uuid,
            'name': name,
            'filename': filename,
            'metadata': metadata,
            'synced_at': datetime.now().isoformat()
        })
    
    removed = 0  # We keep deleted scripts, so always 0
    
    has_changes = added > 0 or updated > 0 or removed > 0
    
    if include_manifest and has_changes:
        manifest_path = output_dir / "manifest.json"
        manifest = {'scripts': [], 'last_updated': datetime.now().isoformat()}
        
        if manifest_path.exists():
            try:
                with open(manifest_path) as f:
                    manifest = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        
        existing_uuids = {s['uuid'] for s in manifest.get('scripts', [])}
        
        for exp in exported:
            if exp['uuid'] in existing_uuids:
                manifest['scripts'] = [
                    s if s['uuid'] != exp['uuid'] else exp
                    for s in manifest['scripts']
                ]
            else:
                manifest['scripts'].append(exp)
        
        manifest['last_updated'] = datetime.now().isoformat()
        
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)
        
        print(f"  Updated manifest.json")
    
    return exported, added, updated, removed


def init_git_repo(output_dir: Path) -> bool:
    """Initialize git repository if not already initialized.
    
    Returns True if this is a new repo (first sync).
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    
    git_dir = output_dir / ".git"
    is_new = not git_dir.exists()
    
    if is_new:
        subprocess.run(['git', 'init'], cwd=output_dir, capture_output=True)
        
        gitignore_path = output_dir / ".gitignore"
        if not gitignore_path.exists():
            with open(gitignore_path, 'w') as f:
                f.write(".DS_Store\n")
        
        readme_path = output_dir / "README.md"
        if not readme_path.exists():
            with open(readme_path, 'w') as f:
                f.write("# Userscripts\n\n")
                f.write("This repository contains userscripts synced from Tweeks by NextByte.\n\n")
                f.write("Managed by [tweeks-sync](https://github.com/yourusername/tweeks-sync).\n")
        
        print(f"Initialized git repository in {output_dir}")
    
    return is_new


def git_commit(output_dir: Path, added: int, updated: int, removed: int, is_first_sync: bool = False):
    """Commit changes with a summary message."""
    if not is_first_sync and added == 0 and updated == 0 and removed == 0:
        print("No script changes to commit.")
        return
    
    subprocess.run(['git', 'add', '-A'], cwd=output_dir, capture_output=True)
    
    commit_msg = f"{added} added; {removed} removed; {updated} updated"
    result = subprocess.run(
        ['git', 'commit', '-m', commit_msg],
        cwd=output_dir,
        capture_output=True,
        text=True
    )
    
    if result.returncode == 0:
        print(f"Committed: {commit_msg}")
    elif "nothing to commit" in result.stdout.lower() or "nothing to commit" in result.stderr.lower():
        print("No changes to commit.")
    else:
        print(f"Commit failed: {result.stderr}")


def sync(output_dir: Path, include_manifest: bool = True, dest_dir: Optional[Path] = None):
    """Main sync function."""
    if not ensure_chrome_closed():
        sys.exit(1)
    
    print("Scanning for Tweeks extensions...")
    databases = find_tweeks_databases()
    
    if not databases:
        print("No Tweeks extensions found.")
        return
    
    all_scripts = {}
    
    for db_path in databases:
        profile_dir = db_path.parent.parent
        
        if not verify_tweeks_extension(profile_dir):
            print(f"  Warning: Could not verify Tweeks extension in {profile_dir.name}")
            continue
        
        print(f"Extracting scripts from {profile_dir.name}...")
        scripts = extract_userscripts(db_path)
        all_scripts.update(scripts)
    
    if not all_scripts:
        print("No userscripts found.")
        return
    
    print(f"\nFound {len(all_scripts)} userscript(s)")
    print(f"Exporting to {output_dir}...")
    
    is_first_sync = init_git_repo(output_dir)
    exported, added, updated, removed = export_userscripts(all_scripts, output_dir, include_manifest)
    
    git_commit(output_dir, added, updated, removed, is_first_sync)
    
    if dest_dir:
        copy_to_destination(output_dir, dest_dir)
    
    print(f"\nSync complete. {len(exported)} script(s) processed.")


def main():
    parser = argparse.ArgumentParser(
        description="Sync userscripts from Tweeks by NextByte Chrome extension"
    )
    parser.add_argument(
        '-o', '--output',
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory for userscripts (default: {DEFAULT_OUTPUT_DIR})"
    )
    parser.add_argument(
        '-d', '--dest',
        type=Path,
        default=None,
        help="Destination directory to copy scripts with 'tweeks.' prefix"
    )
    parser.add_argument(
        '--no-manifest',
        action='store_true',
        help="Don't create/update manifest.json"
    )
    parser.add_argument(
        '--list',
        action='store_true',
        help="List found userscripts without exporting"
    )
    
    args = parser.parse_args()
    
    if args.list:
        print("Scanning for Tweeks extensions...")
        databases = find_tweeks_databases()
        
        for db_path in databases:
            profile_dir = db_path.parent.parent
            print(f"\n{profile_dir.name}:")
            scripts = extract_userscripts(db_path)
            for uuid, script in scripts.items():
                metadata = parse_userscript_metadata(script)
                name = metadata.get('name', uuid)
                print(f"  - {name}")
        return
    
    dest_dir = get_destination_dir(args.dest)
    sync(args.output, include_manifest=not args.no_manifest, dest_dir=dest_dir)


if __name__ == "__main__":
    main()
