# Plan: Upgrade `fetch_tokens` — Direct API Key Creation (Skip Region)

## Temuan dari Testing Live

Dari test langsung via Playwright tadi, terbukti bahwa:
1. Setelah login Google berhasil (cookies aktif di browser), `page.evaluate()` → `POST /console/api/client/v1/api-keys` **langsung berhasil** — bahkan di halaman "Account Access Restricted"
2. **Region TIDAK perlu di-set** untuk create API key
3. **`user_enterprise_id: "personal-edition-user-id"` hardcode works** — tidak perlu fetch `/console/accounts` dulu
4. API key langsung `status: "active"`

## Perubahan yang Akan Dilakukan

### File: `scripts/auth/app/providers/codebuddy.py`

#### 1. Tambah env var baru untuk kontrol mode (line ~89)

```python
# Fast mode: skip region selection, directly create API key after login.
# Proven to work — API key creation doesn't require region to be set.
CODEBUDDY_FAST_TOKEN_MODE = (
    os.getenv("BATCHER_CODEBUDDY_FAST_TOKEN_MODE", "true").lower() == "true"
)
```

Default `"true"` (aktif) karena sudah terbukti works.

#### 2. Rewrite `fetch_tokens` method (line 2952-3016)

**Strategi baru (fast mode ON):**
```
Login berhasil → page.evaluate() POST /api-keys → done!
```

**Fallback (fast mode OFF atau fast mode gagal):**
```
Login → Set Region → Fetch Enterprise ID → Create Key (flow lama)
```

Logika baru:
1. **Try fast path dulu** — langsung `_create_api_key_via_page(page)` tanpa region/enterprise ID
2. **Jika berhasil** → save cookies, return API key ✅
3. **Jika gagal** → fallback ke flow lama (set region → fetch enterprise ID → create key)

#### 3. Upgrade `_create_api_key_via_page` function (line 1480-1546)

Perubahan:
- Tambah parameter `retries: int = 2` untuk retry logic built-in
- Tambah jeda antar retry (exponential backoff ringan)
- Improve error logging (log response body on failure untuk debugging)
- Keep `credentials: 'include'` (best practice, meskipun test tadi tanpa itu juga works karena same-origin)

#### 4. Tambah fungsi baru `_create_api_key_fast`

Wrapper yang:
- Langsung panggil `_create_api_key_via_page` dengan default `"personal-edition-user-id"`
- Retry 2x jika gagal
- Jika masih gagal, return None (trigger fallback ke flow lama)

## Flow Baru (Diagram)

```
fetch_tokens()
│
├── [FAST MODE = true]
│   ├── _create_api_key_fast(page)  ← langsung, no region, no enterprise ID fetch
│   │   ├── retry 1: _create_api_key_via_page(page, "personal-edition-user-id")
│   │   └── retry 2: _create_api_key_via_page(page, "personal-edition-user-id")
│   │
│   ├── SUCCESS? → save cookies → return {api_key, state} ✅
│   └── FAIL? → fallback ke flow lama ↓
│
├── [FALLBACK / FAST MODE = false]
│   ├── _ensure_region_with_retry(page)
│   ├── _fetch_console_accounts_via_page(page) → user_enterprise_id
│   ├── _create_api_key_via_page(page, user_enterprise_id)
│   └── save cookies → return {api_key, state}
│
└── ALL FAIL → raise RetryableBatcherError
```

## Keuntungan

| Aspek | Sebelum | Sesudah |
|-------|---------|---------|
| Steps setelah login | 3 (region + enterprise + key) | 1 (key langsung) |
| Network requests | 4-6 | 1 |
| Waktu | ~10-15s | ~2-3s |
| Page navigations | 2-3 | 0 |
| Reliability | Bisa gagal di region page | Lebih robust (skip UI interaction) |

## Backward Compatibility

- Env var `BATCHER_CODEBUDDY_FAST_TOKEN_MODE=false` → kembali ke flow lama
- Jika fast mode gagal → otomatis fallback ke flow lama
- Tidak ada breaking change
