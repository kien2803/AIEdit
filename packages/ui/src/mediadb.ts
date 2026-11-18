/**
 * Media Asset Storage — IndexedDB-backed persistent media store.
 *
 * blob: URLs die with the page session, so every imported file is stored here
 * keyed by asset id. Project JSON only stores asset metadata; on load we
 * re-resolve `sourceUrl` from this store. Peaks are stored too so waveforms
 * survive reload without re-decoding audio.
 */

const DB_NAME = "aiedit-media";
const DB_VERSION = 1;
const STORE = "media"; // key: assetId → { blob: Blob, peaks?: number[] }

interface MediaRecord {
  blob: Blob;
  peaks?: number[];
  /** Poster thumbnail (dataURL, ~160px wide). */
  thumb?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putMedia(assetId: string, blob: Blob): Promise<void> {
  const existing = await tx<MediaRecord | undefined>("readonly", (s) => s.get(assetId) as IDBRequest<MediaRecord | undefined>).catch(() => undefined);
  await tx("readwrite", (s) => s.put({ blob, ...(existing?.peaks ? { peaks: existing.peaks } : {}) }, assetId));
}

export async function getMedia(assetId: string): Promise<Blob | null> {
  const rec = await tx<MediaRecord | undefined>("readonly", (s) => s.get(assetId) as IDBRequest<MediaRecord | undefined>).catch(() => undefined);
  return rec?.blob ?? null;
}

export async function putPeaks(assetId: string, peaks: number[]): Promise<void> {
  const rec = await tx<MediaRecord | undefined>("readonly", (s) => s.get(assetId) as IDBRequest<MediaRecord | undefined>).catch(() => undefined);
  if (!rec) return;
  await tx("readwrite", (s) => s.put({ ...rec, peaks }, assetId));
}

export async function getPeaks(assetId: string): Promise<number[] | null> {
  const rec = await tx<MediaRecord | undefined>("readonly", (s) => s.get(assetId) as IDBRequest<MediaRecord | undefined>).catch(() => undefined);
  return rec?.peaks ?? null;
}

export async function putThumb(assetId: string, thumb: string): Promise<void> {
  const rec = await tx<MediaRecord | undefined>("readonly", (s) => s.get(assetId) as IDBRequest<MediaRecord | undefined>).catch(() => undefined);
  if (!rec) return;
  await tx("readwrite", (s) => s.put({ ...rec, thumb }, assetId));
}

export async function getThumb(assetId: string): Promise<string | null> {
  const rec = await tx<MediaRecord | undefined>("readonly", (s) => s.get(assetId) as IDBRequest<MediaRecord | undefined>).catch(() => undefined);
  return rec?.thumb ?? null;
}

export async function deleteMedia(assetId: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(assetId)).catch(() => {});
}

/** GC helper: ids present in the store that are not referenced by the project. */
export async function listMediaIds(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).catch(() => [] as IDBValidKey[]);
  return keys.map(String);
}
