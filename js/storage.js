/* =========================================================
   Local session storage (IndexedDB).
   Data stays in THIS browser on THIS device. Not cloud-backed.
   A session is written once, when recording stops. Nothing is
   written every second.
   ========================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'solar-tracker-sy-k-05';
  const STORE = 'sessions';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in global) || !global.indexedDB) {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      let req;
      try { req = global.indexedDB.open(DB_NAME, VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  function run(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('Storage transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted (storage may be full)'));
    }));
  }

  global.SessionStore = {
    getAll: () => run('readonly', (s) => s.getAll()),
    put: (session) => run('readwrite', (s) => s.put(session)),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear())
  };
})(window);
