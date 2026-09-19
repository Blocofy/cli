# CLI — müşteri geri bildirimi programı

Master plan platform deposunda (tek kaynak): `Blocofy/blocofy` →
`docs/architecture/plans/2026-09-17-customer-feedback-program.md`, senkron commit `854b57e4bc570d758438df7bfc9a56280cba1ae2`.

Bu depodaki sahiplik (C1, C2, C4 CLI yarısı, T5 `THEME_DIRS`, T9 status/exit kodları, T4 `site` komutları):

| Parça | Sahip dosya |
| --- | --- |
| Kimlik deposu v2 + migration + sır deposu | `lib/credentials.mjs`, `lib/secret-store.mjs` (yeni) |
| Proje bağı + hedef çözümleme + uzak doğrulama | `lib/target.mjs` (yeni) |
| Hedef bloğu + hata zarfı + exit kodları | `lib/output.mjs` (yeni) |
| Staged tema pull | `lib/theme-sync.mjs` |
| Sayfa CAS/plan/retry | `lib/content-sync.mjs`, `lib/http.mjs` (yeni, Retry-After) |
| Site State | `lib/site-state.mjs` (yeni) |
| Komut yüzeyi + yardım | `bin/blocofy.mjs` |

Base: `origin/main` `14d0b71c0741a17052d35d43cdc987b081f4587d`; baseline `node --test` 172/172.
