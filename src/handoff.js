// Hand a binary from one tool page to another without saving it to disk first.
// IndexedDB holds the bytes (structured-cloned, so arbitrary size) under a single
// pending slot; the receiving page takes and clears it on load.

const DB_NAME = "cemporter";
const STORE = "handoff";
const SLOT = "pending";

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function putHandoff(name, data, target = "hex") {
    const db = await openDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put({ name, data, target, at: Date.now() }, SLOT);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function takeHandoff(target = "hex") {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            const get = store.get(SLOT);
            get.onsuccess = () => {
                if (!get.result || (get.result.target ?? "hex") !== target) {
                    resolve(null);
                    return;
                }
                store.delete(SLOT);
                resolve(get.result);
            };
            get.onerror = () => reject(get.error);
        });
    } finally {
        db.close();
    }
}
