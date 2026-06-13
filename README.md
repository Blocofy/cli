# @blocofy/cli

Blocofy tema geliştirme CLI — Shopify CLI modeli: local tema + **canlı veri** ile anında
önizleme, sonra yayına alma. CLI **build almaz**; asset'leri kendi araçlarınla
(npm/Vite/Tailwind) üretirsin, platform Liquid + statik asset olarak sunar.

```bash
npx @blocofy/cli login          # site URL + dev token (admin → Ayarlar → Tema CLI token'ları)
cd path/to/tema
npx @blocofy/cli theme dev       # http://localhost:3030 — local tema + canlı veri, livereload
```

## Komutlar

```bash
blocofy login [--url <url>] [--token <bcf_…>]
                          # Platform URL + dev token kaydet (~/.blocofy/credentials.json, 0600).
blocofy theme dev [dir]   # Local dev sunucusu: düzenle → tarayıcı otomatik yenilenir.
                          # --port <n> (varsayılan 3030)
blocofy theme pull [dir]  # Canlı temayı diske indir.
blocofy theme push [dir]  # Local temayı canlı siteye yaz (create/update; silme yok).
blocofy --version
blocofy --help
```

## Nasıl çalışır

`theme dev` kendi http sunucusunu açar; her sayfa isteğinde local tema dosyalarını okuyup
platformun dev-render endpoint'ine (`/api/dev/render`) gönderir. Platform site'ın **canlı
verisiyle** render edip HTML döner — yani CLI render motorunu içermez, üretimle birebir aynı
çıktı görürsün. `fs.watch` ile dosya değişince tarayıcı SSE üzerinden yenilenir.

Kimlik bilgisi: `~/.blocofy/credentials.json` ya da `BLOCOFY_URL` + `BLOCOFY_TOKEN` ortam
değişkenleri (CI/agent için).

## Geliştirme

Zero-dependency (yalnız Node yerleşikleri). Test:

```bash
node --test
```

Node ≥ 18 gerekir.

## Lisans

[MIT](./LICENSE)
