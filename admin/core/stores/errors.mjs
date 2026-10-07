export class StoreError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export const conflict = () => new StoreError(
  'This was changed by someone else (or in another tab) after you opened it. Reload the page to get the latest version, then make your change again.',
  409,
);

// Store interface (implemented by github.mjs and fs.mjs):
//   publishes                     true when saving updates the live site
//   list(dir)                     → [{ name, version, text }] for *.md files
//   create(path, text, message)   → version; 409 if the file exists
//   update(path, text, version, message) → version; 409 if version is stale
//   remove(path, version, message)
//   listFiles(dir)                → ['public/assets/...', ...]
//   check()                       → { ok, detail }
