# ConfX

> Браузерное расширение для выгрузки Confluence и Jira в Markdown, CSV, изображения и ZIP-архивы.

![Статус](https://img.shields.io/badge/status-active-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![Manifest](https://img.shields.io/badge/manifest-v3-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![Runtime](https://img.shields.io/badge/runtime-node.js-111827?style=for-the-badge&logo=nodedotjs&logoColor=5b5ef4)
![Лицензия](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)

[English version](README.md)

| Поле | Значение |
|---|---|
| Статус | Active |
| Тип | Браузерное расширение / инструмент выгрузки host-страниц |
| Host-браузеры | Chrome / Chromium, Яндекс Браузер |
| Основной стек | Manifest V3, React 18, TypeScript, Vite, CRXJS, Tailwind CSS |
| Release-артефакты | `confx-chrome.zip`, `confx-yandex.crx`, `SHA256SUMS` |
| Быстрая проверка | `npm ci && npx tsc --build --force && npx vitest run && npm run release:all` |
| Уровень проверки | Run-confirmed во время release maintenance, если это указано в release notes |

## Скриншоты

Скриншоты пока не добавлены. Перед публичным релизом стоит подготовить:

- Chrome side panel на ширине 320-360px.
- Chrome side panel на ширине 480px.
- Popup fallback в Яндекс Браузере.
- Страницу Markdown viewer.

## Возможности

- **Page export**: выгрузка текущей страницы Confluence в Markdown, CSV-таблицы, изображения и manifest.
- **Space export**: выгрузка пространства Confluence, если текущий контекст страницы это поддерживает.
- **Subtree export**: рекурсивная выгрузка дочерних страниц и генерация навигационного `README.md`.
- **Picker**: выбор блока на странице, предпросмотр и выгрузка только выбранного блока.
- **Watch**: сохранение snapshots и просмотр изменений во времени.
- **Jira support**: извлечение полезного содержимого Jira issue, если текущая вкладка открыта на задаче.
- **Rule engine**: настройка правил извлечения секций и таблиц под соглашения страниц Confluence.

## Установка из GitHub Releases

Публикация в Chrome Web Store сейчас намеренно не входит в scope. Для текущего release flow канал распространения — GitHub Releases.

| Браузер | Артефакт | Установка | Заметки |
|---|---|---|---|
| Chrome / Chromium | `confx-chrome.zip` | Распаковать ZIP, затем загрузить папку через `chrome://extensions` | Нужно включить Developer Mode. В корне архива лежит `manifest.json`. |
| Яндекс Браузер | `confx-yandex.crx` | Перетащить CRX в `browser://tune` | CRX подписан release-ключом ConfX для Яндекс Браузера. |

Всегда скачивайте `SHA256SUMS` из того же релиза и сверяйте checksum перед ручной установкой артефактов.

## Локальная разработка

```sh
npm ci
npm run dev
```

Chrome development build:

```sh
npm run build:chrome
```

Загрузите `dist/` через `chrome://extensions` с включённым Developer Mode.

Yandex development build требует локальный ключ подписи:

```sh
npm run gen:key:yandex
npm run release:yandex
```

Сгенерированный локальный ключ предназначен только для разработки, если команда явно не назначила его release-ключом.

## Release-артефакты

```sh
npm run release:chrome   # dist/ -> release/confx-chrome.zip
npm run release:yandex   # dist-yandex/ -> release/confx-yandex.crx
npm run release:all      # оба артефакта и release/SHA256SUMS
```

`release:all` падает, если отсутствует Yandex signing key. Это ожидаемо: полный релиз должен включать оба browser artifacts.

Generated outputs игнорируются и не должны попадать в git:

- `dist/`
- `dist-yandex/`
- `release/`
- `keys/`
- `*.crx`
- `*.zip`
- `*.pem`

## GitHub Actions distribution

Release workflow собирает оба артефакта и публикует их как workflow artifacts. Для тегов `v*` он также прикрепляет артефакты к GitHub Release.

Обязательные secret и release variable:

| Имя | Тип | Назначение |
|---|---|---|
| `YANDEX_CRX_PRIVATE_KEY_B64` | GitHub Actions secret | Base64-кодированный private signing key для `confx-yandex.crx`. |
| `YANDEX_EXTENSION_ID` | Workflow env / secret override | Ожидаемый Yandex extension ID. Значение релиза по умолчанию: `cjhpodjghfokdfoljmfbgibjjfpafdip`. |

Workflow записывает private key во временный файл, использует его только для Yandex build, валидирует вычисленный extension ID и удаляет файл в конце job.

## Поддержка браузеров

| Возможность | Chrome / Chromium | Яндекс Браузер |
|---|---|---|
| Manifest V3 | Поддерживается | Поддерживается |
| Основной UI | Side panel | Popup fallback / совместимый extension UI |
| `side_panel` в manifest | Есть | Есть для совместимости |
| `action.default_popup` | Не включается | Включается в Yandex target |
| Direct GitHub artifact | `confx-chrome.zip` | `confx-yandex.crx` |
| Стабильность extension ID | Зависит от install channel | Зависит от Yandex signing key |

## Permissions and security

ConfX использует browser session cookies для чтения Confluence и Jira через текущий browser context. Отдельный Confluence token не нужен.

Manifest permissions включают доступ к tabs, scripting, downloads, storage и host permissions для HTTP/HTTPS страниц. Учитывайте этот широкий доступ перед установкой development builds.

Yandex CRX signing требует аккуратной работы:

- не коммитьте private keys;
- не отправляйте ключи в issues, чат или документацию;
- храните release keys в secret manager или GitHub Actions secrets;
- валидируйте `YANDEX_EXTENSION_ID` перед публикацией release artifacts.

## Проверка

```sh
npm ci
npx tsc --build --force
npx vitest run
npm run release:all
```

Проверка корня Chrome ZIP:

```sh
python3 - <<'PY'
import zipfile

with zipfile.ZipFile('release/confx-chrome.zip') as archive:
    assert 'manifest.json' in archive.namelist()
PY
```

Manual browser smoke checks перед публичным релизом:

1. Загрузить `dist/` в Chrome и проверить side panel на 320-360px и 480px.
2. Установить `release/confx-yandex.crx` в Яндекс Браузере и проверить popup fallback.
3. Выгрузить одну страницу Confluence и убедиться, что ZIP содержит Markdown и manifest files.

## Диагностика проблем

| Проблема | Проверка |
|---|---|
| Chrome ZIP не устанавливается | Убедитесь, что архив распакован, а `manifest.json` лежит в корне выбранной папки. |
| Yandex release падает | Проверьте `YANDEX_KEY_PATH` или локальный `keys/yandex.pem`. |
| Yandex extension ID изменился | Проверьте signing key и `YANDEX_EXTENSION_ID`. Другой ключ создаёт другую extension identity. |
| Side panel обрезается | Используйте свежий релиз; узкие Chrome side panel layouts поддерживаются явно. |
| Export падает на странице | Проверьте, что вы залогинены в Confluence/Jira в том же browser profile. |

## Структура проекта

```text
src/
  manifest.ts              # MV3 manifest через CRXJS
  background/              # service worker и routing browser UI
  content/                 # picker и injected page controls
  sidepanel/               # React side panel и popup UI
  options/                 # редактор rules/settings
  viewer/                  # Markdown viewer page
  lib/                     # extraction pipeline
  types/                   # shared TypeScript models
scripts/
  zip-chrome.mjs           # Chrome ZIP artifact
  pack-yandex.mjs          # signed Yandex CRX artifact
  checksums.mjs            # SHA256SUMS generation
```

## Статус

ConfX активно поддерживается как browser extension release flow. Chrome Web Store publishing запланирован отдельно и не входит в текущую автоматизацию.

## Лицензия

MIT
