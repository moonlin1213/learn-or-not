// OAuth 凭据存储：与学习数据库分离，owner-only + 原子替换。
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EMPTY = Object.freeze({ version: 1, credentials: {} });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validCredential(value) {
  return value && typeof value === 'object'
    && value.type === 'oauth'
    && typeof value.access === 'string' && value.access.length > 0
    && typeof value.refresh === 'string' && value.refresh.length > 0
    && Number.isFinite(value.expires);
}

export class OAuthCredentialStore {
  constructor(filename) {
    this.filename = filename;
    this.chains = new Map();
  }

  readDocument() {
    try {
      const stat = fs.statSync(this.filename);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error(`OAuth 凭据文件权限不安全：请执行 chmod 600 "${this.filename}"`);
      }
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (parsed?.version !== 1 || !parsed.credentials || typeof parsed.credentials !== 'object') {
        throw new Error('OAuth 凭据文件格式无效');
      }
      const credentials = {};
      for (const [id, credential] of Object.entries(parsed.credentials)) {
        if (validCredential(credential)) credentials[id] = credential;
      }
      return { version: 1, credentials };
    } catch (error) {
      if (error?.code === 'ENOENT') return clone(EMPTY);
      throw error;
    }
  }

  writeDocument(document) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const tmp = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.filename);
      if (process.platform !== 'win32') fs.chmodSync(this.filename, 0o600);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 已 rename 或无需清理 */ }
    }
  }

  enqueue(providerId, task) {
    const previous = this.chains.get(providerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.chains.set(providerId, current);
    return current.finally(() => {
      if (this.chains.get(providerId) === current) this.chains.delete(providerId);
    });
  }

  async withFileLock(task) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const lockfile = `${this.filename}.lock`;
    let fd;
    for (let attempt = 0; attempt < 600; attempt++) {
      try {
        fd = fs.openSync(lockfile, 'wx', 0o600);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lockfile).mtimeMs > 300_000) fs.unlinkSync(lockfile);
        } catch { /* 另一进程可能刚释放 */ }
        await sleep(50);
      }
    }
    if (fd == null) throw new Error('OAuth 凭据正被另一个进程使用，请稍后重试');
    try {
      return await task();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockfile); } catch { /* ignore */ }
    }
  }

  async read(providerId) {
    return clone(this.readDocument().credentials[providerId]);
  }

  async list() {
    return Object.entries(this.readDocument().credentials)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId, fn) {
    return this.enqueue(providerId, () => this.withFileLock(async () => {
      const document = this.readDocument();
      const current = clone(document.credentials[providerId]);
      const next = await fn(current);
      if (next !== undefined) {
        if (!validCredential(next)) throw new Error(`OAuth 凭据格式无效：${providerId}`);
        document.credentials[providerId] = clone(next);
        this.writeDocument(document);
      }
      return clone(document.credentials[providerId]);
    }));
  }

  async delete(providerId) {
    return this.enqueue(providerId, () => this.withFileLock(async () => {
      const document = this.readDocument();
      if (!(providerId in document.credentials)) return;
      delete document.credentials[providerId];
      this.writeDocument(document);
    }));
  }
}

export function readOAuthCredentialFile(filename, providerId) {
  const stat = fs.statSync(filename);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`OAuth 来源文件权限不安全：请执行 chmod 600 "${filename}"`);
  }
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const credential = parsed?.credentials?.[providerId];
  if (!validCredential(credential)) throw new Error(`没有找到可用的 ${providerId} OAuth 登录`);
  return clone(credential);
}
