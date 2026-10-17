import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const relative = (file) => path.relative(root, file).split(path.sep).join('/');
export const under = (file, prefix) => file === prefix || file.startsWith(prefix + '/');

// Deliberately independent of gitignore: all files, including hidden files,
// are checked. Only .git and each caller's explicit allowlist are excluded.
export function walk(dir = root, excluded = []) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.name === '.git' || excluded.some((prefix) => under(relative(file), prefix))) continue;
    if (entry.isSymbolicLink()) {
      // Do not let a link hide payloads or lead the scan outside the checkout.
      const target = fs.realpathSync(file);
      if (!inside(root, target) || fs.statSync(target).isDirectory()) {
        throw new Error('Unsupported scan symlink: ' + relative(file));
      }
    }
    if (entry.isDirectory()) files.push(...walk(file, excluded));
    else files.push(file);
  }
  return files;
}

export function inside(base, file) {
  const rel = path.relative(base, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

export function localPath(base, ref) {
  if (typeof ref !== 'string' || !ref.trim() || path.isAbsolute(ref) || /^[A-Za-z]:|^[\\/]/u.test(ref)) {
    throw new Error('Component path must be relative to its plugin directory');
  }
  const file = path.resolve(base, ref);
  if (!inside(base, file)) throw new Error('Component path escapes plugin directory: ' + ref);
  if (fs.existsSync(file) && !inside(fs.realpathSync(base), fs.realpathSync(file))) {
    throw new Error('Component symlink escapes plugin directory: ' + ref);
  }
  return file;
}

export function pluginDir(entry) {
  if (typeof entry.source !== 'string') throw new Error('Only local plugin sources can be checked offline');
  return localPath(root, entry.source);
}

// Commands may be metadata objects with a source path and inline prose.
// Other component maps may map names directly to paths.
export function componentPaths(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(componentPaths);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      (typeof item === 'string' && ['content', 'description', 'argumentHint', 'model'].includes(key))
        ? [] : componentPaths(item));
  }
  throw new Error('Invalid component path declaration');
}

// Shell words concatenate quoted and unquoted segments. Split only outside
// quotes, and remove quoting before deriving local executable references.
export function commandTokens(command, separators = /\s|[;|&`]/u) {
  const tokens = [];
  let token = '';
  let quote = '';
  let started = false;
  const flush = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\' && /["\\]/u.test(command[i + 1] || '')) token += command[++i];
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (separators.test(char)) flush();
    else if (char === '\\' && i + 1 < command.length) {
      token += command[++i];
      started = true;
    } else {
      token += char;
      started = true;
    }
  }
  flush();
  return tokens;
}

// Extract local executable references from decoded config string leaves.
export function commandReferences(value, dir) {
  if (typeof value === 'string') {
    const substitute = (token) => token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
      (match, braced, bare) => (braced || bare) === 'CLAUDE_PLUGIN_ROOT' ? '.' : process.env[braced || bare] ?? match);
    const tokens = commandTokens(value);
    // Retain token references, including missing paths and quoted spaces.
    const refs = new Set(tokens.map(substitute).filter((token) => token.startsWith('./')));
    if (dir) {
      // Options, assignments and attached redirections can embed a file in a
      // shell word. Only existing in-plugin files become fragment references.
      // Union quote-aware fragments (preserving quoted filenames) with naive
      // fragments of effective shell words (including quoted metacharacters).
      const separators = /[=<>|;&()\s]/u;
      const fragments = new Set([
        ...commandTokens(value, separators),
        ...tokens.flatMap((token) => token.split(separators)),
      ]);
      // A whole quoted option can still contain a filename with spaces or
      // equals signs. Keep the full fragment and both assignment suffixes.
      const candidates = new Set(fragments);
      for (const fragment of fragments) {
        if (!fragment.includes('=')) continue;
        candidates.add(fragment.slice(fragment.indexOf('=') + 1));
        candidates.add(fragment.slice(fragment.lastIndexOf('=') + 1));
      }
      for (const fragment of candidates) {
        if (!fragment) continue;
        const file = path.resolve(dir, substitute(fragment));
        if (!inside(dir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        const ref = './' + path.relative(dir, file).split(path.sep).join('/');
        localPath(dir, ref); // Apply the same symlink boundary as declarations.
        refs.add(ref);
      }
    }
    return [...refs];
  }
  if (value && typeof value === 'object') return Object.values(value).flatMap((item) => commandReferences(item, dir));
  return [];
}

const contentFields = ['commands', 'agents', 'skills', 'outputStyles', 'themes'];
const configFields = ['hooks', 'mcpServers', 'lspServers', 'monitors', 'settings'];

// Marketplace entries augment manifest components even when strict is set.
// Keep every source's declarations; overwriting a field would hide payloads.
export function componentDeclarations(...sources) {
  return Object.fromEntries([...contentFields, ...configFields].flatMap((field) => {
    const values = sources.filter((source) => Object.hasOwn(source, field)).map((source) => source[field]);
    return values.length ? [[field, values]] : [];
  }));
}

export function declaredPaths(plugin, dir) {
  const refs = [];
  // Top-level allowedTools is a permissions list, outside component fields.
  // Within component maps, names (including allowedTools) never hide subtrees.
  for (const field of contentFields) {
    if (Object.hasOwn(plugin, field)) {
      for (const ref of componentPaths(plugin[field])) refs.push({ field, ref });
    }
  }
  // Config fields may be a file path, a list of file paths, or inline config.
  for (const field of configFields) {
    const collect = (value, direct = false, key = '') => {
      if (typeof value === 'string') {
        if (direct) refs.push({ field, ref: value });
        else if (key !== 'command' && value.startsWith('./')) refs.push({ field, ref: value });
        for (const ref of commandReferences(value, dir)) refs.push({ field, ref });
      } else if (Array.isArray(value)) value.forEach((item) => collect(item, direct, key));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => collect(item, false, name));
    };
    collect(plugin[field], true);
  }
  const seen = new Set();
  return refs.filter(({ field, ref }) => {
    const key = JSON.stringify([field, ref]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
