// 端末内の保存。学習記録と取り込んだ private 問題は IndexedDB、設定は localStorage。
// 外部には何も送らない。

const DB_NAME = 'shikaku';
const DB_VERSION = 2; // 2: 確認の印（reviews）を追加
const SETTINGS_KEY = 'shikaku.settings';

let dbPromise = null;
let staleHandler = null;
let blockedHandler = null;
/** 別のタブが保存の形を更新して、この画面の接続が閉じられたときに呼ぶ関数を登録する */
export function onStale(fn) { staleHandler = fn; }
/**
 * 古い版のタブが保存を開いたままで、この画面が保存を開けないとき（blocked）と、
 * そのタブが閉じられて開けたとき（connected）に呼ぶ関数を登録する。
 * blocked でも失敗にはせず、開けるのを待つ（古いタブを閉じれば、そのまま続きが動く）。
 */
export function onBlocked(fn) { blockedHandler = fn; }

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('この環境では端末内の保存（IndexedDB）が使えません')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      let wasBlocked = false;
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          const rec = db.createObjectStore('records', { keyPath: 'id' }); // 学習記録（追記のみ）
          rec.createIndex('examId', 'examId');
        }
        if (!db.objectStoreNames.contains('private')) {
          const priv = db.createObjectStore('private', { keyPath: 'id' }); // 取り込んだ問題 { id, examId, batch, fileName, importedAt, question }
          priv.createIndex('batch', 'batch');
        }
        if (!db.objectStoreNames.contains('reviews')) {
          const rev = db.createObjectStore('reviews', { keyPath: 'id' }); // 確認の印（追記のみ）{ id, questionId, at, status, note, device }
          rev.createIndex('questionId', 'questionId');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { // 別のタブが新しい版の保存を開こうとしている。つながったままだと相手が待たされるので閉じる
          db.close();
          dbPromise = null;
          if (staleHandler) staleHandler();
        };
        resolve(db);
        if (wasBlocked && blockedHandler) blockedHandler('connected');
      };
      req.onerror = () => reject(req.error || new Error('端末内の保存を開けませんでした'));
      req.onblocked = () => { wasBlocked = true; if (blockedHandler) blockedHandler('blocked'); }; // 失敗にせず、開けるのを待つ
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let req;
    try { req = fn(store); } catch (e) { try { tx.abort(); } catch { /* すでに終わっている */ } reject(e); return; }
    // fn が getAll() などの要求を返したときだけ、その結果を返す（put/delete などは undefined）
    tx.oncomplete = () => resolve(req instanceof IDBRequest ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}

// ---------- 学習記録 ----------

export const getAllRecords = () => run('records', 'readonly', (s) => s.getAll());
export const addRecord = (r) => run('records', 'readwrite', (s) => { s.put(r); });
export const putRecords = (list) => run('records', 'readwrite', (s) => { for (const r of list) s.put(r); });

// ---------- 確認の印（確認済み／誤りかも） ----------

export const getAllReviews = () => run('reviews', 'readonly', (s) => s.getAll());
export const addReview = (r) => run('reviews', 'readwrite', (s) => { s.put(r); });
export const putReviews = (list) => run('reviews', 'readwrite', (s) => { for (const r of list) s.put(r); });

// ---------- 取り込んだ private 問題 ----------

export const getPrivateRows = () => run('private', 'readonly', (s) => s.getAll());
export const putPrivateRows = (rows) => run('private', 'readwrite', (s) => { for (const r of rows) s.put(r); });
export async function deletePrivateBatch(batch) {
  const rows = await getPrivateRows();
  await run('private', 'readwrite', (s) => { for (const r of rows) if (r.batch === batch) s.delete(r.id); });
}
export async function deleteAllPrivate() {
  await run('private', 'readwrite', (s) => { s.clear(); });
}

// ---------- 設定（localStorage） ----------

const DEFAULT_SETTINGS = { deviceName: '', currentExam: '', examDates: {}, passLines: {}, lastExportAt: '', persistAsked: false };

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 設定を保存する。保存できなければ false */
export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; } catch { return false; }
}

// ---------- 消されにくくする ----------

export async function persistStatus() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

export async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
    return (await navigator.storage.persist()) ? 'persisted' : 'denied';
  } catch {
    return 'unsupported';
  }
}
