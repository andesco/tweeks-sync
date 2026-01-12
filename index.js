#!/usr/bin/env node

/**
 * Tweeks Sync - Export userscripts from Tweeks by NextByte Chrome extension.
 * 
 * This tool scans all Chrome profiles for the Tweeks extension and exports
 * userscripts to a git repository.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { createInterface } from 'readline';

const TWEEKS_EXTENSION_ID = 'fmkancpjcacjodknfjcpmgkccbhedkhc';
const CHROME_SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const DEFAULT_OUTPUT_DIR = join(homedir(), 'Developer', 'tweeks-userscripts');
const CONFIG_FILE = join(homedir(), '.config', 'tweeks-sync', 'config.json');

// --- Config ---

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveConfig(config) {
  const dir = join(homedir(), '.config', 'tweeks-sync');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getDestinationDir(destFlag) {
  const config = loadConfig();
  
  if (destFlag) {
    config.destination = destFlag;
    saveConfig(config);
    return destFlag;
  }
  
  if ('destination' in config) {
    return config.destination || null;
  }
  
  console.log('\n📁 Optional: Set a destination directory to copy userscripts to.');
  console.log("   Scripts will be copied with 'tweeks.' prefix (e.g., tweeks.script-name.user.js)");
  console.log('   Press Enter to skip, or enter a path:\n');
  
  const response = await prompt('Destination directory: ');
  
  if (response) {
    const dest = response.replace(/^~/, homedir());
    config.destination = dest;
    saveConfig(config);
    console.log(`Saved destination: ${dest}`);
    return dest;
  }
  
  config.destination = null;
  saveConfig(config);
  return null;
}

// --- Chrome Management ---

function isChromeRunning() {
  const result = spawnSync('pgrep', ['-x', 'Google Chrome']);
  return result.status === 0;
}

function quitChrome() {
  const result = spawnSync('osascript', ['-e', 'tell application "Google Chrome" to quit']);
  return result.status === 0;
}

async function ensureChromeClosed() {
  if (!isChromeRunning()) {
    return true;
  }
  
  console.log('⚠️  Google Chrome is running.');
  console.log('Chrome must be closed to read the userscript database (LevelDB lock).');
  console.log();
  
  while (true) {
    const response = await prompt('Quit Chrome now? [Y/n/manual]: ');
    const lower = response.toLowerCase();
    
    if (lower === '' || lower === 'y' || lower === 'yes') {
      console.log('Quitting Chrome...');
      if (quitChrome()) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (!isChromeRunning()) {
            console.log('Chrome closed successfully.');
            return true;
          }
        }
        console.log('Chrome is still running. Please close it manually.');
        return false;
      } else {
        console.log('Failed to quit Chrome. Please close it manually.');
        return false;
      }
    } else if (lower === 'n' || lower === 'no') {
      console.log('Cannot proceed while Chrome is running.');
      return false;
    } else if (lower === 'manual') {
      console.log('Please close Chrome manually, then press Enter...');
      await prompt('');
      if (!isChromeRunning()) {
        return true;
      }
      console.log('Chrome is still running.');
    } else {
      console.log("Please enter 'y' (quit), 'n' (cancel), or 'manual'.");
    }
  }
}

// --- Utilities ---

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[-\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseUserscriptMetadata(script) {
  const metadata = {};
  const match = script.match(/\/\/\s*==UserScript==(.*?)\/\/\s*==\/UserScript==/s);
  if (!match) return metadata;
  
  const header = match[1];
  for (const line of header.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      const content = trimmed.slice(2).trim();
      const m = content.match(/^@(\w+)\s+(.*)/);
      if (m) {
        const [, key, value] = m;
        if (key in metadata) {
          if (Array.isArray(metadata[key])) {
            metadata[key].push(value);
          } else {
            metadata[key] = [metadata[key], value];
          }
        } else {
          metadata[key] = value;
        }
      }
    }
  }
  return metadata;
}

// --- Database Operations ---

function findTweeksDatabases() {
  const databases = [];
  
  if (!existsSync(CHROME_SUPPORT_DIR)) {
    console.log(`Chrome support directory not found: ${CHROME_SUPPORT_DIR}`);
    return databases;
  }
  
  for (const entry of readdirSync(CHROME_SUPPORT_DIR)) {
    const profileDir = join(CHROME_SUPPORT_DIR, entry);
    if (!statSync(profileDir).isDirectory()) continue;
    if (!entry.startsWith('Profile') && entry !== 'Default') continue;
    
    const extensionSettings = join(profileDir, 'Local Extension Settings', TWEEKS_EXTENSION_ID);
    if (existsSync(extensionSettings)) {
      databases.push(extensionSettings);
      console.log(`Found Tweeks database in: ${entry}`);
    }
  }
  
  return databases;
}

function verifyTweeksExtension(profileDir) {
  const extensionsDir = join(profileDir, 'Extensions', TWEEKS_EXTENSION_ID);
  if (!existsSync(extensionsDir)) return false;
  
  for (const versionDir of readdirSync(extensionsDir)) {
    const versionPath = join(extensionsDir, versionDir);
    if (!statSync(versionPath).isDirectory()) continue;
    
    const manifestPath = join(versionPath, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (manifest.name && manifest.name.includes('Tweeks')) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

function extractUserscripts(dbPath) {
  const scripts = {};
  
  function parseScriptsFromText(text) {
    const found = {};
    let idx = 0;
    
    while (true) {
      const start = text.indexOf('{"', idx);
      if (start === -1) break;
      
      if (!text.slice(start, start + 5000).includes('==UserScript==')) {
        idx = start + 1;
        continue;
      }
      
      let braceCount = 0;
      let end = start;
      let inString = false;
      let escapeNext = false;
      
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (c === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (c === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }
        
        if (inString) continue;
        
        if (c === '{') braceCount++;
        else if (c === '}') {
          braceCount--;
          if (braceCount === 0) {
            end = i + 1;
            break;
          }
        }
      }
      
      if (end > start) {
        const jsonStr = text.slice(start, end);
        try {
          const data = JSON.parse(jsonStr);
          if (typeof data === 'object' && data !== null) {
            for (const [uuid, script] of Object.entries(data)) {
              if (typeof script === 'string' && script.includes('==UserScript==')) {
                found[uuid] = script;
              }
            }
          }
        } catch {}
        idx = end;
      } else {
        idx = start + 1;
      }
    }
    
    return found;
  }
  
  // Read .log files
  for (const file of readdirSync(dbPath)) {
    if (!file.endsWith('.log')) continue;
    try {
      const content = readFileSync(join(dbPath, file), 'utf-8');
      Object.assign(scripts, parseScriptsFromText(content));
    } catch (e) {
      console.log(`  Warning: Could not read ${file}: ${e.message}`);
    }
  }
  
  // Fallback to .ldb files using strings
  if (Object.keys(scripts).length === 0) {
    for (const file of readdirSync(dbPath)) {
      if (!file.endsWith('.ldb')) continue;
      try {
        const result = spawnSync('strings', [join(dbPath, file)], { encoding: 'utf-8' });
        if (result.stdout) {
          Object.assign(scripts, parseScriptsFromText(result.stdout));
        }
      } catch (e) {
        console.log(`  Warning: Could not read ${file}: ${e.message}`);
      }
    }
  }
  
  return scripts;
}

// --- Export Operations ---

function exportUserscripts(scripts, outputDir, includeManifest = true) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  const exported = [];
  let added = 0;
  let updated = 0;
  
  for (const [uuid, script] of Object.entries(scripts)) {
    const metadata = parseUserscriptMetadata(script);
    const name = metadata.name || uuid;
    const slug = slugify(name);
    const filename = `${slug}.user.js`;
    const filepath = join(outputDir, filename);
    
    const isNew = !existsSync(filepath);
    let contentChanged = false;
    
    if (!isNew) {
      const existingContent = readFileSync(filepath, 'utf-8');
      contentChanged = existingContent !== script;
    }
    
    if (isNew || contentChanged) {
      writeFileSync(filepath, script);
      
      if (isNew) {
        added++;
        console.log(`  Added: ${filename}`);
      } else {
        updated++;
        console.log(`  Updated: ${filename}`);
      }
    } else {
      console.log(`  Unchanged: ${filename}`);
    }
    
    exported.push({
      uuid,
      name,
      filename,
      metadata,
      synced_at: new Date().toISOString()
    });
  }
  
  const removed = 0; // We keep deleted scripts
  const hasChanges = added > 0 || updated > 0 || removed > 0;
  
  if (includeManifest && hasChanges) {
    const manifestPath = join(outputDir, 'manifest.json');
    let manifest = { scripts: [], last_updated: new Date().toISOString() };
    
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } catch {}
    }
    
    const existingUuids = new Set(manifest.scripts?.map(s => s.uuid) || []);
    
    for (const exp of exported) {
      if (existingUuids.has(exp.uuid)) {
        manifest.scripts = manifest.scripts.map(s => s.uuid === exp.uuid ? exp : s);
      } else {
        manifest.scripts.push(exp);
      }
    }
    
    manifest.last_updated = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('  Updated manifest.json');
  }
  
  return { exported, added, updated, removed };
}

// --- Git Operations ---

function initGitRepo(outputDir) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  const gitDir = join(outputDir, '.git');
  const isNew = !existsSync(gitDir);
  
  if (isNew) {
    spawnSync('git', ['init'], { cwd: outputDir });
    
    const gitignorePath = join(outputDir, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '.DS_Store\n');
    }
    
    const readmePath = join(outputDir, 'README.md');
    if (!existsSync(readmePath)) {
      writeFileSync(readmePath, 
        '# Userscripts\n\n' +
        'This repository contains userscripts synced from Tweeks by NextByte.\n\n' +
        'Managed by [tweeks-sync](https://github.com/yourusername/tweeks-sync).\n'
      );
    }
    
    console.log(`Initialized git repository in ${outputDir}`);
  }
  
  return isNew;
}

function gitCommit(outputDir, added, updated, removed, isFirstSync = false) {
  if (!isFirstSync && added === 0 && updated === 0 && removed === 0) {
    console.log('No script changes to commit.');
    return;
  }
  
  spawnSync('git', ['add', '-A'], { cwd: outputDir });
  
  const commitMsg = `${added} added; ${removed} removed; ${updated} updated`;
  const result = spawnSync('git', ['commit', '-m', commitMsg], { cwd: outputDir, encoding: 'utf-8' });
  
  if (result.status === 0) {
    console.log(`Committed: ${commitMsg}`);
  } else if (result.stdout?.toLowerCase().includes('nothing to commit') || 
             result.stderr?.toLowerCase().includes('nothing to commit')) {
    console.log('No changes to commit.');
  } else {
    console.log(`Commit failed: ${result.stderr}`);
  }
}

// --- Destination Copy ---

function copyToDestination(outputDir, destDir) {
  if (!destDir) return;
  
  const dest = destDir.replace(/^~/, homedir());
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  
  let added = 0;
  let skipped = 0;
  let overwritten = 0;
  
  for (const file of readdirSync(outputDir)) {
    if (!file.endsWith('.user.js')) continue;
    
    const srcPath = join(outputDir, file);
    const destFilename = `tweeks.${file}`;
    const destPath = join(dest, destFilename);
    
    if (existsSync(destPath)) {
      const srcContent = readFileSync(srcPath, 'utf-8');
      const destContent = readFileSync(destPath, 'utf-8');
      if (srcContent === destContent) {
        skipped++;
        continue;
      }
      copyFileSync(srcPath, destPath);
      overwritten++;
    } else {
      copyFileSync(srcPath, destPath);
      added++;
    }
  }
  
  console.log(`Destination: ${added} added; ${skipped} skipped; ${overwritten} overwritten`);
}

// --- Main ---

async function sync(outputDir, includeManifest, destDir) {
  if (!await ensureChromeClosed()) {
    process.exit(1);
  }
  
  console.log('Scanning for Tweeks extensions...');
  const databases = findTweeksDatabases();
  
  if (databases.length === 0) {
    console.log('No Tweeks extensions found.');
    return;
  }
  
  const allScripts = {};
  
  for (const dbPath of databases) {
    const profileDir = join(dbPath, '..', '..');
    const profileName = basename(join(dbPath, '..', '..'));
    
    if (!verifyTweeksExtension(profileDir)) {
      console.log(`  Warning: Could not verify Tweeks extension in ${profileName}`);
      continue;
    }
    
    console.log(`Extracting scripts from ${profileName}...`);
    const scripts = extractUserscripts(dbPath);
    Object.assign(allScripts, scripts);
  }
  
  if (Object.keys(allScripts).length === 0) {
    console.log('No userscripts found.');
    return;
  }
  
  console.log(`\nFound ${Object.keys(allScripts).length} userscript(s)`);
  console.log(`Exporting to ${outputDir}...`);
  
  const isFirstSync = initGitRepo(outputDir);
  const { exported, added, updated, removed } = exportUserscripts(allScripts, outputDir, includeManifest);
  
  gitCommit(outputDir, added, updated, removed, isFirstSync);
  
  if (destDir) {
    copyToDestination(outputDir, destDir);
  }
  
  console.log(`\nSync complete. ${exported.length} script(s) processed.`);
}

async function listScripts() {
  console.log('Scanning for Tweeks extensions...');
  const databases = findTweeksDatabases();
  
  for (const dbPath of databases) {
    const profileName = basename(join(dbPath, '..', '..'));
    console.log(`\n${profileName}:`);
    
    const scripts = extractUserscripts(dbPath);
    for (const [uuid, script] of Object.entries(scripts)) {
      const metadata = parseUserscriptMetadata(script);
      const name = metadata.name || uuid;
      console.log(`  - ${name}`);
    }
  }
}

function normalizePath(path) {
  return path
    .replace(/^~/, homedir())
    .replace(/\\ /g, ' ')      // unescape spaces
    .replace(/^["']|["']$/g, ''); // remove surrounding quotes
}

async function setDestination(path) {
  const config = loadConfig();
  
  if (path) {
    const dest = normalizePath(path);
    config.destination = dest;
    saveConfig(config);
    console.log(`Destination set to: ${dest}`);
  } else {
    console.log('\n📁 Set destination directory for userscript copies.');
    console.log("   Scripts will be copied with 'tweeks.' prefix (e.g., tweeks.script-name.user.js)");
    console.log('   Enter a path or press Enter to clear:\n');
    
    const response = await prompt('Destination directory: ');
    
    if (response) {
      const dest = normalizePath(response);
      config.destination = dest;
      saveConfig(config);
      console.log(`Destination set to: ${dest}`);
    } else {
      config.destination = null;
      saveConfig(config);
      console.log('Destination cleared.');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  let outputDir = DEFAULT_OUTPUT_DIR;
  let destFlag = null;
  let noManifest = false;
  let listOnly = false;
  let setDest = false;
  let setDestPath = null;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') {
      outputDir = normalizePath(args[++i] || '') || outputDir;
    } else if (arg === '-d' || arg === '--dest') {
      destFlag = normalizePath(args[++i] || '') || null;
    } else if (arg === '--set-dest') {
      setDest = true;
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        setDestPath = normalizePath(nextArg);
        i++;
      }
    } else if (arg === '--no-manifest') {
      noManifest = true;
    } else if (arg === '--list') {
      listOnly = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: tweeks-sync [options]

Options:
  -o, --output <dir>   Output directory for userscripts (default: ~/Developer/tweeks-userscripts)
  -d, --dest <dir>     Destination directory to copy scripts with 'tweeks.' prefix
  --set-dest [dir]     Set/update destination directory (prompts if no path given)
  --no-manifest        Don't create/update manifest.json
  --list               List found userscripts without exporting
  -h, --help           Show this help message

npm scripts:
  npm start / npm run sync   Sync userscripts
  npm run list               List found userscripts
  npm run set                Set destination directory (interactive)
  npm run set -- <path>      Set destination directory to <path>`);
      return;
    }
  }
  
  if (setDest) {
    await setDestination(setDestPath);
    return;
  }
  
  if (listOnly) {
    await listScripts();
    return;
  }
  
  const destDir = await getDestinationDir(destFlag);
  await sync(outputDir, !noManifest, destDir);
}

main().catch(console.error);
