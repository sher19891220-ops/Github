const CACHE_NAME = 'pti-v1'
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline', queued: true }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )
    return
  }
  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fetch(event.request).then((res) => {
        const clone = res.clone()
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
        return res
      })
    ).catch(() => caches.match('/'))
  )
})

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-inspections') {
    event.waitUntil(syncPendingInspections())
  }
})

async function syncPendingInspections() {
  const db = await openDB()
  const pending = await getFromDB(db, 'pending_inspections')
  for (const item of pending) {
    try {
      await fetch('/api/inspections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      })
      await removeFromDB(db, 'pending_inspections', item.id)
    } catch {}
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pti-offline', 1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('pending_inspections')) {
        db.createObjectStore('pending_inspections', { keyPath: 'id' })
      }
    }
  })
}

function getFromDB(db, storeName) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => resolve([])
  })
}

function removeFromDB(db, storeName, id) {
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(id)
    tx.oncomplete = resolve
  })
}
