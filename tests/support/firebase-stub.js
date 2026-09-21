// In-memory stand-in for the Firebase compat SDK, injected in place of the real scripts so tests
// never touch the live project. It mimics the behaviour the game relies on:
//   - writes notify listeners synchronously (like Firebase's local events),
//   - `undefined` values throw (Firebase rejects them),
//   - empty objects/arrays are not stored (Firebase drops them).
// Tests reach in through window.__fb.
(function () {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function assertNoUndefined(v, path) {
    if (v === undefined) throw new Error('Firebase: undefined value written at ' + path);
    if (v && typeof v === 'object') Object.keys(v).forEach((k) => assertNoUndefined(v[k], path + '/' + k));
  }

  // Firebase does not store empty objects/arrays or nulls.
  function normalize(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) {
      const arr = v.map(normalize);
      return arr.length ? arr : null;
    }
    if (typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach((k) => { const n = normalize(v[k]); if (n !== null) out[k] = n; });
      return Object.keys(out).length ? out : null;
    }
    return v;
  }

  const split = (p) => String(p).split('/').filter(Boolean);

  const db = {
    root: {},
    log: [], // {op, path}
    listeners: [],
    notifying: false,
    dirty: false,
    seq: 0,

    get(path) {
      let cur = db.root;
      for (const k of split(path)) {
        if (cur === null || typeof cur !== 'object' || !(k in cur)) return null;
        cur = cur[k];
      }
      return cur === undefined ? null : cur;
    },

    write(path, value) {
      assertNoUndefined(value, path);
      const keys = split(path);
      const v = normalize(clone(value));
      if (!keys.length) { db.root = v || {}; }
      else {
        let cur = db.root;
        for (let i = 0; i < keys.length - 1; i++) {
          if (cur[keys[i]] === null || typeof cur[keys[i]] !== 'object' || Array.isArray(cur[keys[i]])) {
            if (v === null) { db.notify(); return; }
            cur[keys[i]] = {};
          }
          cur = cur[keys[i]];
        }
        const last = keys[keys.length - 1];
        if (v === null) delete cur[last]; else cur[last] = v;
        // prune empty ancestors
        for (let n = keys.length - 1; n > 0; n--) {
          const parent = db.get(keys.slice(0, n).join('/'));
          if (parent && typeof parent === 'object' && !Object.keys(parent).length) {
            const up = db.get(keys.slice(0, n - 1).join('/')) || db.root;
            delete up[keys[n - 1]];
          }
        }
      }
      db.notify();
    },

    notify() {
      if (db.notifying) { db.dirty = true; return; }
      db.notifying = true;
      try {
        let guard = 0;
        do {
          db.dirty = false;
          db.listeners.slice().forEach((l) => {
            if (!l.ready) return;
            if (l.type === 'value') {
              const cur = JSON.stringify(db.get(l.path));
              if (cur !== l.last) { l.last = cur; l.cb(new Snapshot(l.path)); }
            } else if (l.type === 'child_added') {
              const val = db.get(l.path);
              const keys = val && typeof val === 'object' ? Object.keys(val) : [];
              keys.forEach((k) => { if (!l.known.has(k)) { l.known.add(k); l.cb(new Snapshot(l.path + '/' + k)); } });
              l.known.forEach((k) => { if (!keys.includes(k)) l.known.delete(k); });
            }
          });
        } while (db.dirty && ++guard < 50);
      } finally { db.notifying = false; }
    }
  };
  db.root['.info'] = { connected: true };

  class Snapshot {
    constructor(path) { this.path = path; this.key = split(path).slice(-1)[0] || null; this.ref = new Ref(path); }
    val() { return clone(db.get(this.path)); }
    exists() { return db.get(this.path) !== null; }
    numChildren() { const v = db.get(this.path); return v && typeof v === 'object' ? Object.keys(v).length : 0; }
    child(p) { return new Snapshot(this.path + '/' + p); }
    forEach(cb) {
      const v = db.get(this.path);
      if (!v || typeof v !== 'object') return false;
      for (const k of Object.keys(v)) { if (cb(new Snapshot(this.path + '/' + k)) === true) return true; }
      return false;
    }
  }

  class Query {
    constructor(path, orderKey, limit) { this.path = path; this.orderKey = orderKey; this.limit = limit; }
    orderByChild(k) { return new Query(this.path, k, this.limit); }
    limitToLast(n) { return new Query(this.path, this.orderKey, n); }
    once() {
      const v = db.get(this.path);
      let entries = v && typeof v === 'object' ? Object.entries(v) : [];
      if (this.orderKey) entries.sort((a, b) => ((a[1] && a[1][this.orderKey]) || 0) - ((b[1] && b[1][this.orderKey]) || 0));
      if (this.limit) entries = entries.slice(-this.limit);
      const snap = new Snapshot(this.path);
      snap.val = () => (entries.length ? clone(Object.fromEntries(entries)) : null);
      snap.exists = () => entries.length > 0;
      return Promise.resolve(snap);
    }
  }

  class Ref extends Query {
    constructor(path) { super(split(path).join('/')); }
    get key() { return split(this.path).slice(-1)[0] || null; }
    child(p) { return new Ref(this.path + '/' + p); }
    set(v) { db.log.push({ op: 'set', path: this.path }); db.write(this.path, v); return Promise.resolve(); }
    update(obj) {
      db.log.push({ op: 'update', path: this.path });
      Object.keys(obj).forEach((k) => assertNoUndefined(obj[k], this.path + '/' + k));
      Object.keys(obj).forEach((k) => db.write(this.path + '/' + k, obj[k]));
      return Promise.resolve();
    }
    remove() { db.log.push({ op: 'remove', path: this.path }); db.write(this.path, null); return Promise.resolve(); }
    push(v) {
      const key = '-Kstub' + String(++db.seq).padStart(6, '0');
      const ref = this.child(key);
      const p = v === undefined ? Promise.resolve() : ref.set(v);
      // like the real ThenableReference: awaiting it resolves to the plain (non-thenable) ref
      const thenable = Object.create(ref);
      thenable.then = (res, rej) => p.then(() => res(ref), rej);
      return thenable;
    }
    once(type, cb) {
      const p = Promise.resolve(new Snapshot(this.path));
      if (typeof cb === 'function') p.then(cb); // callback form, like the real SDK
      return p;
    }
    on(type, cb) {
      const l = { path: this.path, type, cb, last: undefined, known: new Set(), ready: false };
      db.listeners.push(l);
      Promise.resolve().then(() => {
        l.ready = true;
        if (type === 'value') { l.last = JSON.stringify(db.get(l.path)); cb(new Snapshot(l.path)); }
        else db.notify();
      });
      return cb;
    }
    off(type, cb) {
      db.listeners = db.listeners.filter((l) => !(l.path === this.path && (!type || l.type === type) && (!cb || l.cb === cb)));
    }
    transaction(fn) {
      db.log.push({ op: 'transaction', path: this.path });
      const cur = db.get(this.path);
      const res = fn(clone(cur));
      if (res === undefined) return Promise.resolve({ committed: false, snapshot: new Snapshot(this.path) });
      db.write(this.path, res);
      return Promise.resolve({ committed: true, snapshot: new Snapshot(this.path) });
    }
  }

  // ---- Firestore -------------------------------------------------------------------------
  const firestoreData = { collections: {}, adds: [] };
  function fsCollection(name) {
    const docs = () => (firestoreData.collections[name] = firestoreData.collections[name] || {});
    const api = {
      orderBy() { return api; },
      limit() { return api; },
      get() {
        const entries = Object.entries(docs());
        return Promise.resolve({ forEach: (cb) => entries.forEach(([id, d]) => cb({ id, data: () => clone(d) })) });
      },
      doc(id) {
        return { get: () => Promise.resolve({ exists: !!docs()[id], id, data: () => clone(docs()[id]) }) };
      },
      add(data) {
        const id = 'doc' + (Object.keys(docs()).length + 1);
        docs()[id] = clone(data);
        firestoreData.adds.push({ collection: name, data: clone(data) });
        return Promise.resolve({ id });
      }
    };
    return api;
  }

  // ---- Auth ------------------------------------------------------------------------------
  const authObj = {
    currentUser: null,
    signInAnonymously() { authObj.currentUser = { uid: window.__fbUid || 'test-uid' }; return Promise.resolve(); }
  };

  const firebase = {
    apps: [],
    initializeApp() { firebase.apps.push({}); },
    auth: () => authObj,
    firestore: Object.assign(() => ({ collection: fsCollection }), { FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) } }),
    database: Object.assign(() => ({ ref: (p) => new Ref(p || '') }), { ServerValue: { TIMESTAMP: { '.sv': 'timestamp' } } })
  };

  window.firebase = firebase;
  window.__fb = { db, firestore: firestoreData, auth: authObj, Ref };
})();
