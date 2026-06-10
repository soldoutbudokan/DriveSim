/**
 * Persistence: multiple driver profiles (localStorage) and recorded drives
 * (IndexedDB — typed arrays are stored natively, so replays stay compact).
 */

import { setProgressNamespace } from '../game/progress';

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
}

interface ProfileRegistry {
  list: Profile[];
  activeId: string;
}

const PKEY = 'drivesim.profiles.v1';

function loadRegistry(): ProfileRegistry {
  try {
    const raw = localStorage.getItem(PKEY);
    if (raw) {
      const reg = JSON.parse(raw) as ProfileRegistry;
      if (reg.list.length) return reg;
    }
  } catch {
    /* fresh */
  }
  const first: Profile = { id: 'p1', name: 'Driver', createdAt: Date.now() };
  return { list: [first], activeId: first.id };
}

function saveRegistry(reg: ProfileRegistry): void {
  try {
    localStorage.setItem(PKEY, JSON.stringify(reg));
  } catch {
    /* unavailable */
  }
}

export class Profiles {
  private reg = loadRegistry();

  constructor() {
    this.applyNamespace();
  }

  private applyNamespace(): void {
    setProgressNamespace(`drivesim.p.${this.reg.activeId}`);
  }

  get active(): Profile {
    return this.reg.list.find((p) => p.id === this.reg.activeId) ?? this.reg.list[0];
  }

  get all(): Profile[] {
    return [...this.reg.list];
  }

  switch(id: string): void {
    if (!this.reg.list.some((p) => p.id === id)) return;
    this.reg.activeId = id;
    saveRegistry(this.reg);
    this.applyNamespace();
  }

  create(name: string): Profile {
    const p: Profile = { id: `p${Date.now().toString(36)}`, name: name.trim() || 'Driver', createdAt: Date.now() };
    this.reg.list.push(p);
    this.reg.activeId = p.id;
    saveRegistry(this.reg);
    this.applyNamespace();
    return p;
  }

  rename(id: string, name: string): void {
    const p = this.reg.list.find((x) => x.id === id);
    if (p) {
      p.name = name.trim() || p.name;
      saveRegistry(this.reg);
    }
  }

  /** Delete a profile and all of its stored data. */
  async remove(id: string): Promise<void> {
    if (this.reg.list.length <= 1) return;
    this.reg.list = this.reg.list.filter((p) => p.id !== id);
    if (this.reg.activeId === id) this.reg.activeId = this.reg.list[0].id;
    saveRegistry(this.reg);
    this.applyNamespace();
    try {
      localStorage.removeItem(`drivesim.p.${id}.progress.v1`);
    } catch {
      /* fine */
    }
    const keys = await listReplayKeys(id);
    for (const k of keys) await deleteReplay(k);
  }

  /** Reset the active profile's progress + replays. */
  async resetActive(): Promise<void> {
    try {
      localStorage.removeItem(`drivesim.p.${this.reg.activeId}.progress.v1`);
    } catch {
      /* fine */
    }
    const keys = await listReplayKeys(this.reg.activeId);
    for (const k of keys) await deleteReplay(k);
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB replay store                                              */
/* ------------------------------------------------------------------ */

export interface StoredReplayMeta {
  key: string;
  profileId: string;
  at: number;
  mode: string;
  durationS: number;
  faultCount: number;
  score: number | null;
  passed: boolean | null;
}

const DB_NAME = 'drivesim';
const STORE = 'replays';
const MAX_REPLAYS_PER_PROFILE = 10;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('profileId', 'meta.profileId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveReplay(record: { key: string; meta: StoredReplayMeta; data: unknown }): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // trim old replays
    const keys = await listReplayMetas(record.meta.profileId);
    if (keys.length > MAX_REPLAYS_PER_PROFILE) {
      const excess = keys.sort((a, b) => a.at - b.at).slice(0, keys.length - MAX_REPLAYS_PER_PROFILE);
      for (const m of excess) await deleteReplay(m.key);
    }
  } catch {
    /* storage unavailable — replay just isn't saved */
  }
}

export async function listReplayMetas(profileId: string): Promise<StoredReplayMeta[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const out: StoredReplayMeta[] = [];
      const cursorReq = tx.objectStore(STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur) {
          const val = cur.value as { meta: StoredReplayMeta };
          if (val.meta.profileId === profileId) out.push(val.meta);
          cur.continue();
        } else {
          resolve(out.sort((a, b) => b.at - a.at));
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch {
    return [];
  }
}

async function listReplayKeys(profileId: string): Promise<string[]> {
  return (await listReplayMetas(profileId)).map((m) => m.key);
}

export async function getReplay(key: string): Promise<{ meta: StoredReplayMeta; data: unknown } | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as { meta: StoredReplayMeta; data: unknown }) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function deleteReplay(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* fine */
  }
}
