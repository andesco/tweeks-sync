#!/usr/bin/env node

/**
 * Tweeks Sync - Export userscripts from Tweeks by NextByte Chrome extension.
 * 
 * This tool scans all Chrome profiles for the Tweeks extension and exports
 * userscripts to a git repository.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, renameSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, basename, dirname } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { Level } from 'level';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TWEEKS_EXTENSION_ID = 'fmkancpjcacjodknfjcpmgkccbhedkhc';
const CHROME_SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const DEFAULT_OUTPUT_DIR = join(dirname(__dirname), 'tweeks-userscripts');
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

async function ensureChromeClosed() {
  if (!isChromeRunning()) {
    return true;
  }
  
  console.log('⚠️  Google Chrome is running.');
  console.log('Chrome must be closed to read the userscript database (LevelDB lock).');
  console.log('Please close Chrome and press Enter to continue, or Ctrl+C to cancel.\n');
  
  await prompt('Press Enter when Chrome is closed...');
  
  if (!isChromeRunning()) {
    return true;
  }
  
  console.log('Chrome is still running. Cannot proceed.');
  return false;
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
    let stats;
    try {
      stats = statSync(profileDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (!entry.startsWith('Profile') && entry !== 'Default') continue;
    
    const extensionSettings = join(profileDir, 'Local Extension Settings', TWEEKS_EXTENSION_ID);
    if (existsSync(extensionSettings)) {
      databases.push(extensionSettings);
      console.log(`Found Tweeks database in: ${entry}`);
    }
  }
  
  return databases;
}

function verifyTweeksExtension(profileDir, debug = false) {
  const extensionsDir = join(profileDir, 'Extensions', TWEEKS_EXTENSION_ID);
  if (!existsSync(extensionsDir)) {
    if (debug) {
      console.log(`  Debug: Extensions dir not found:\n  ${extensionsDir}`);
    }
    return false;
  }
  
  for (const versionDir of readdirSync(extensionsDir)) {
    const versionPath = join(extensionsDir, versionDir);
    if (!statSync(versionPath).isDirectory()) continue;
    
    const manifestPath = join(versionPath, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (debug) {
          console.log(`  Debug: manifest path:\n  ${manifestPath}`);
          console.log(`  Debug: manifest name: ${manifest?.name || '(missing)'}`);
        }
        if (manifest.name && manifest.name.includes('Tweeks')) {
          return true;
        }
      } catch {}
      if (debug) {
        console.log(`  Debug: manifest read/parse failed:\n  ${manifestPath}`);
      }
    }
  }
  return false;
}

async function extractUserscripts(dbPath, debug = false) {
  const scripts = {};
  let needsClose = false;
  
  async function parseScriptsFromLevelDb(pathToDb) {
    const found = {};
    const db = new Level(pathToDb, {
      createIfMissing: false,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8'
    });
    
    try {
      await db.open();
      const iterator = db.iterator();
      for await (const [key, value] of iterator) {
        if (typeof value !== 'string') continue;
        if (!value.includes('==UserScript==')) continue;
        
        if (value.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(value);
            for (const [uuid, script] of Object.entries(parsed)) {
              if (typeof script === 'string' && script.includes('==UserScript==')) {
                found[uuid] = script;
              }
            }
            continue;
          } catch {}
        }
        
        Object.assign(found, parseScriptsFromText(value));
      }
      await iterator.close();
    } catch (error) {
      const message = error?.message || String(error);
      const code = error?.code ? ` (${error.code})` : '';
      if (debug) {
        console.log(`  Debug: LevelDB read failed in:\n  ${pathToDb}\n  ${message}${code}`);
      }
      const lower = message.toLowerCase();
      if (lower.includes('lock') || error?.code === 'LEVEL_LOCKED') {
        needsClose = true;
      }
    } finally {
      await db.close();
    }
    
    return found;
  }
  
  function parseScriptsFromText(text) {
    const found = {};
    const keyRegex = /"([0-9a-fA-F-]{36})":"/g;
    let match;
    
    while ((match = keyRegex.exec(text))) {
      const uuid = match[1];
      let i = match.index + match[0].length;
      let value = '';
      let escaped = false;
      
      for (; i < text.length; i++) {
        const c = text[i];
        if (escaped) {
          value += c;
          escaped = false;
          continue;
        }
        if (c === '\\') {
          value += c;
          escaped = true;
          continue;
        }
        if (c === '"') {
          break;
        }
        value += c;
      }
      
      if (value.includes('==UserScript==')) {
        let decoded = '';
        for (let j = 0; j < value.length; j++) {
          const ch = value[j];
          if (ch !== '\\') {
            decoded += ch;
            continue;
          }
          const next = value[++j];
          if (next === undefined) break;
          if (next === 'n') decoded += '\n';
          else if (next === 'r') decoded += '\r';
          else if (next === 't') decoded += '\t';
          else if (next === 'b') decoded += '\b';
          else if (next === 'f') decoded += '\f';
          else if (next === '"') decoded += '"';
          else if (next === '\\') decoded += '\\';
          else if (next === 'u') {
            const hex = value.slice(j + 1, j + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              decoded += String.fromCharCode(parseInt(hex, 16));
              j += 4;
            } else {
              decoded += '\\u';
            }
          } else {
            decoded += `\\${next}`;
          }
        }
        
        if (decoded.includes('==UserScript==')) {
          found[uuid] = decoded;
        }
      }
      
      keyRegex.lastIndex = i + 1;
    }
    
    return found;
  }
  
  function readLevelDbText(filePath) {
    try {
      const result = spawnSync('strings', [filePath], { encoding: 'utf-8' });
      if (result.stdout) return result.stdout;
      if (debug && result.error) {
        console.log(`  Debug: strings failed for:\n  ${filePath}\n  ${result.error.message}`);
      }
    } catch {}
    
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }
  
  const entries = readdirSync(dbPath);
  const logFiles = entries.filter(file => file.endsWith('.log'));
  const ldbFiles = entries.filter(file => file.endsWith('.ldb'));

  if (debug) {
    console.log(`  Debug: ${logFiles.length} .log file(s), ${ldbFiles.length} .ldb file(s) in:\n  ${dbPath}`);
  }

  const levelScripts = await parseScriptsFromLevelDb(dbPath);
  Object.assign(scripts, levelScripts);
  
  if (debug) {
    console.log(`  Debug: extracted ${Object.keys(scripts).length} script blob(s) via LevelDB from:\n  ${dbPath}`);
  }
  
  if (Object.keys(scripts).length > 0) {
    return { scripts, needsClose };
  }
  
  let tempDir = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'tweeks-sync-'));
    for (const entry of entries) {
      const srcPath = join(dbPath, entry);
      const destPath = join(tempDir, entry);
      if (statSync(srcPath).isFile()) {
        copyFileSync(srcPath, destPath);
      }
    }
    
    const tempScripts = await parseScriptsFromLevelDb(tempDir);
    Object.assign(scripts, tempScripts);
    
    if (debug) {
      console.log(`  Debug: extracted ${Object.keys(scripts).length} script blob(s) via LevelDB copy from:\n  ${tempDir}`);
    }
    
    if (Object.keys(scripts).length > 0) {
      return { scripts, needsClose };
    }
  } catch (error) {
    if (debug) {
      console.log(`  Debug: temp LevelDB copy failed:\n  ${error.message}`);
    }
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
  
  // Read .log files
  for (const file of logFiles) {
    if (!file.endsWith('.log')) continue;
    try {
      const content = readLevelDbText(join(dbPath, file));
      Object.assign(scripts, parseScriptsFromText(content));
    } catch (e) {
      console.log(`  Warning: Could not read ${file}: ${e.message}`);
    }
  }
  
  // Fallback to .ldb files using strings
  if (Object.keys(scripts).length === 0) {
    for (const file of ldbFiles) {
      if (!file.endsWith('.ldb')) continue;
      try {
        const content = readLevelDbText(join(dbPath, file));
        Object.assign(scripts, parseScriptsFromText(content));
      } catch (e) {
        console.log(`  Warning: Could not read ${file}: ${e.message}`);
      }
    }
  }

  if (debug) {
    console.log(`  Debug: extracted ${Object.keys(scripts).length} script blob(s) from:\n  ${dbPath}`);
  }

  return { scripts, needsClose };
}

// --- Export Operations ---

function exportUserscripts(scripts, outputDir, includeManifest = true, debug = false) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  const exported = [];
  let added = 0;
  let updated = 0;
  let renamed = 0;
  
  const manifestPath = join(outputDir, 'manifest.json');
  let existingManifest = null;
  if (existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {}
  }
  const uuidToFilename = new Map((existingManifest?.scripts || []).map(script => [script.uuid, script.filename]));
  const usedFilenames = new Map();
  for (const [uuid, filename] of uuidToFilename.entries()) {
    if (!usedFilenames.has(filename)) {
      usedFilenames.set(filename, uuid);
    }
  }
  
  const changedUuids = new Set();
  
  for (const [uuid, script] of Object.entries(scripts)) {
    const metadata = parseUserscriptMetadata(script);
    const name = metadata.name || uuid;
    const slug = slugify(name);
    const baseFilename = `${slug}.user.js`;
    let filename = uuidToFilename.get(uuid) || baseFilename;
    if (usedFilenames.has(filename) && usedFilenames.get(filename) !== uuid) {
      filename = `${slug}-${uuid.slice(0, 8)}.user.js`;
    }
    usedFilenames.set(filename, uuid);
    const filepath = join(outputDir, filename);
    
    const previousFilename = uuidToFilename.get(uuid);
    if (previousFilename && previousFilename !== filename) {
      const previousPath = join(outputDir, previousFilename);
      if (existsSync(previousPath) && previousPath !== filepath) {
        if (existsSync(filepath)) {
          unlinkSync(previousPath);
          renamed++;
        } else {
          renameSync(previousPath, filepath);
          renamed++;
        }
      }
    }
    
    const isNew = !existsSync(filepath);
    let contentChanged = false;
    
    if (!isNew) {
      const existingContent = readFileSync(filepath, 'utf-8');
      contentChanged = existingContent !== script;
      if (debug && contentChanged) {
        const existingHash = createHash('sha256').update(existingContent).digest('hex');
        const scriptHash = createHash('sha256').update(script).digest('hex');
        console.log(`  Debug: content hash mismatch for ${filename}`);
        console.log(`  Debug: existing sha256 ${existingHash}`);
        console.log(`  Debug: incoming sha256 ${scriptHash}`);
      }
    }
    
    if (isNew || contentChanged) {
      writeFileSync(filepath, script);
      
      if (isNew) {
        added++;
        changedUuids.add(uuid);
        console.log(`  Added: ${filename}`);
      } else {
        updated++;
        changedUuids.add(uuid);
        console.log(`  Updated: ${filename}`);
      }
    } else {
      console.log(`  Unchanged: ${filename}`);
    }
    
    if (previousFilename && previousFilename !== filename) {
      changedUuids.add(uuid);
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
  const hasChanges = added > 0 || updated > 0 || removed > 0 || renamed > 0;
  
  if (includeManifest && hasChanges) {
    let manifest = { scripts: [], last_updated: new Date().toISOString() };
    
    if (existingManifest) {
      manifest = existingManifest;
    }
    
    const existingScripts = new Map((manifest.scripts || []).map(s => [s.uuid, s]));
    
    for (const exp of exported) {
      if (existingScripts.has(exp.uuid)) {
        if (changedUuids.has(exp.uuid)) {
          manifest.scripts = manifest.scripts.map(s => s.uuid === exp.uuid ? exp : s);
        }
      } else {
        manifest.scripts.push(exp);
      }
    }
    
    manifest.last_updated = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('  Updated manifest.json');
  }
  
  return { exported, added, updated, removed, renamed };
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

function gitCommit(outputDir, added, updated, removed, renamed, isFirstSync = false) {
  if (!isFirstSync && added === 0 && updated === 0 && removed === 0 && renamed === 0) {
    console.log('No script changes to commit.');
    return;
  }
  
  spawnSync('git', ['add', '-A'], { cwd: outputDir });
  
  const commitMsg = `${added} added; ${removed} removed; ${updated} updated; ${renamed} renamed`;
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

async function sync(outputDir, includeManifest, destDir, debug = false) {
  console.log('Scanning for Tweeks extensions...');
  const databases = findTweeksDatabases();
  
  if (databases.length === 0) {
    console.log('No Tweeks extensions found.');
    return;
  }
  
  const allScripts = {};
  let anyNeedsClose = false;
  
  for (const dbPath of databases) {
    const profileDir = join(dbPath, '..', '..');
    const profileName = basename(join(dbPath, '..', '..'));
    
    if (!verifyTweeksExtension(profileDir, debug)) {
      console.log(`  Warning: Could not verify Tweeks extension in ${profileName}; attempting export anyway.`);
    }
    
    console.log(`Extracting scripts from ${profileName}...`);
    const { scripts, needsClose } = await extractUserscripts(dbPath, debug);
    if (needsClose) {
      anyNeedsClose = true;
    }
    Object.assign(allScripts, scripts);
  }
  
  if (Object.keys(allScripts).length === 0 && anyNeedsClose) {
    if (!await ensureChromeClosed()) {
      process.exit(1);
    }
    
    for (const dbPath of databases) {
      const { scripts } = await extractUserscripts(dbPath, debug);
      Object.assign(allScripts, scripts);
    }
  }
  
  if (Object.keys(allScripts).length === 0) {
    console.log('No userscripts found.');
    return;
  }
  
  console.log(`\nFound ${Object.keys(allScripts).length} userscript(s)`);
  console.log(`Exporting to ${outputDir}...`);
  
  const isFirstSync = initGitRepo(outputDir);
  const { exported, added, updated, removed, renamed } = exportUserscripts(allScripts, outputDir, includeManifest, debug);
  
  gitCommit(outputDir, added, updated, removed, renamed, isFirstSync);
  
  if (destDir) {
    copyToDestination(outputDir, destDir);
  }
  
  console.log(`\nSync complete. ${exported.length} script(s) processed.`);
}

async function listScripts(debug = false) {
  console.log('Scanning for Tweeks extensions...');
  const databases = findTweeksDatabases();
  let anyNeedsClose = false;
  let totalScripts = 0;
  
  for (const dbPath of databases) {
    const profileName = basename(join(dbPath, '..', '..'));
    console.log(`\n${profileName}:`);
    
    const { scripts, needsClose } = await extractUserscripts(dbPath, debug);
    if (needsClose) {
      anyNeedsClose = true;
    }
    for (const [uuid, script] of Object.entries(scripts)) {
      const metadata = parseUserscriptMetadata(script);
      const name = metadata.name || uuid;
      console.log(`  - ${name}`);
      totalScripts++;
    }
  }
  
  if (anyNeedsClose && totalScripts === 0) {
    console.log('\nSome databases may be locked by Chrome.');
    if (!await ensureChromeClosed()) {
      process.exit(1);
    }
    
    for (const dbPath of databases) {
      const profileName = basename(join(dbPath, '..', '..'));
      console.log(`\n${profileName}:`);
      
      const { scripts } = await extractUserscripts(dbPath, debug);
      for (const [uuid, script] of Object.entries(scripts)) {
        const metadata = parseUserscriptMetadata(script);
        const name = metadata.name || uuid;
        console.log(`  - ${name}`);
      }
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
  let debug = false;
  
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
    } else if (arg === '--debug') {
      debug = true;
    } else if (arg === '--list') {
      listOnly = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: tweeks-sync [options]

Options:
  -o, --output <dir>   Output directory for userscripts (default: ~/Developer/tweeks-userscripts)
  -d, --dest <dir>     Destination directory to copy scripts with 'tweeks.' prefix
  --set-dest [dir]     Set/update destination directory (prompts if no path given)
  --no-manifest        Don't create/update manifest.json
  --debug              Print extra diagnostics when scanning profiles
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
    await listScripts(debug);
    return;
  }
  
  const destDir = await getDestinationDir(destFlag);
  await sync(outputDir, !noManifest, destDir, debug);
}

main().catch(console.error);
