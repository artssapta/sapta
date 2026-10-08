// Content store backed by the local checkout (development and tests). Same
// contract as the GitHub store; versions are SHA-256 hashes of file contents.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StoreError, conflict } from './errors.mjs';

const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 40);

export function createFsStore(rootDir) {
  const root = path.resolve(rootDir);
  const resolve = rel => {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw new StoreError('Invalid path.', 400);
    return full;
  };
  const readText = async rel => {
    try { return await fs.readFile(resolve(rel), 'utf-8'); } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  // Write a temp file and rename, so a crash never leaves a half-written file.
  const writeAtomic = async (rel, text) => {
    const target = resolve(rel);
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fs.writeFile(tmp, text, 'utf-8');
    try { await fs.rename(tmp, target); } catch (err) { await fs.rm(tmp, { force: true }); throw err; }
  };

  return {
    publishes: false,

    async list(dir) {
      const names = await fs.readdir(resolve(dir)).catch(() => []);
      const out = [];
      for (const name of names.filter(n => n.endsWith('.md'))) {
        const text = await readText(`${dir}/${name}`);
        if (text !== null) out.push({ name, version: hash(text), text });
      }
      return out;
    },

    async create(rel, text) {
      try {
        await fs.writeFile(resolve(rel), text, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') throw new StoreError('An event with this identifier already exists. Choose a different identifier.', 409);
        throw err;
      }
      return hash(text);
    },

    async update(rel, text, version) {
      const current = await readText(rel);
      if (current === null) throw new StoreError('This item no longer exists. Reload the page.', 404);
      if (hash(current) !== version) throw conflict();
      await writeAtomic(rel, text);
      return hash(text);
    },

    async remove(rel, version) {
      const current = await readText(rel);
      if (current === null) throw new StoreError('This item no longer exists. Reload the page.', 404);
      if (hash(current) !== version) throw conflict();
      await fs.unlink(resolve(rel));
    },

    async listFiles(dir, depth = 3) {
      const out = [];
      const walk = async (rel, level) => {
        for (const ent of await fs.readdir(resolve(rel), { withFileTypes: true }).catch(() => [])) {
          if (ent.name.startsWith('.')) continue;
          if (ent.isDirectory()) { if (level < depth) await walk(`${rel}/${ent.name}`, level + 1); } else out.push(`${rel}/${ent.name}`);
        }
      };
      await walk(dir, 1);
      return out;
    },

    async contains(commit, head) {
      return Boolean(commit && head && head.startsWith(commit));
    },

    async check() {
      return { ok: true, detail: `Saving to local files in ${root}. Commit and push to publish.` };
    },
  };
}
