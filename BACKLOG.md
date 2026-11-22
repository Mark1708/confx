# Backlog

## Appearance и README media — текущая доработка

Критерии приёмки:
- Settings schema 6: независимые light/dark/system и violet/blue/forest/graphite/amber;
  прежние light/dark сохраняются с violet, v4→v5 exportDefaults не переписывается.
- Options: доступные radio-карточки, keyboard/focus, retry после ошибки сохранения;
  live appearance без reload на options/workspace/viewer и изолированном launcher.
- Реальный Chromium: контраст, 320/350/600/1120px и font-size 11/22, OS mode lifecycle,
  смена цветов не сбрасывает export draft и не запускает задачу.
- Отдельные EN/RU capture: реальный subtree ZIP 1700/1710, editable sidecars и local links,
  complete download, без внешних запросов и publish/draft/attachment writes.
- GIF 12–30s, ≤5 MiB каждый, decode/hash/dist receipts, OCR и визуальный аудит перед
  явным copy-to-docs; свёрнутые locale-specific README details и неподвижные PNG.

Исторические проверки R2 ниже не доказывают новую сборку или актуальность release artifacts.
Tag/push/перепаковка/remote metadata не входят в эту доработку.

Проверено для текущей доработки: 1147 unit-тестов, 65 sandbox contracts, 49 actual-extension
E2E; privacy, typecheck, Chrome/unsigned Yandex build, lint (0 ошибок, 23 прежних warning)
и format gates. Coverage thresholds сохранены. Отдельные EN/RU captures подтвердили
complete ZIP с двумя страницами/sidecars, local targets и отсутствие content writes.
GIF прошли decode, hash/dist validation, OCR 30 изображений и визуальный аудит;
явный `--copy-to-docs` выполнен. Проверены семь refusal paths driver без изменения public assets.
Это не перепроверка/перепаковка старых ZIP/CRX и не доказательство native OS dialogs.

## R2 — безопасный экспорт и единое рабочее пространство

**Статус:** локальный кандидат R2 `0.3.0` подготовлен и проверен; tag, push, remote cutover и release не выполнялись.
UI-прототип [confx-r2.html](docs/prototypes/confx-r2.html) согласован. Прежние discovery-варианты
Home/profiles/Import superseded этой моделью; отдельный менеджер профилей не вводится.
Наличие выполненного отдельного gate не означает готовность релиза.

Кандидат прошёл typecheck, 1083 unit-теста, 65 sandbox contracts, 45 actual-extension E2E,
privacy и format gates; lint — 0 ошибок и 23 существующих предупреждения. Оба target
собраны, ZIP/CRX содержат root manifest версии `0.3.0`; CRC, SHA256SUMS и RSA-SHA256
подпись CRX3 проверены, существующая Yandex identity сохранена. Native scope — Vivaldi/macOS,
без заявления о native OS dialogs Chrome/Yandex. Приватные отчёты и тестовые OS-артефакты
вынесены во внешний backup с проверкой хешей и удалены из публичного рабочего дерева.

### Продуктовая граница

- Массовое чтение и экспорт страниц остаются.
- Массовое создание, обновление и публикация удалены, не отложены как pending feature.
- `editable.md` — sidecar одной Confluence-страницы. Даже в экспортированном разделе каждый
  такой файл применяется только к своему уже открытому редактору после проверок и diff.
- Confx не нажимает «Опубликовать» и не пишет опубликованную страницу через REST.
- Jira поддерживает экспорт, без обратимого импорта issue body.

### Одна информационная архитектура

Рабочие разделы: **Экспорт**, **Обновление страницы**, **Наблюдение**.
Настройки находятся на единственной options page: export defaults, appearance/language,
launcher, свёрнутые advanced network/rules и диагностика без рабочих тел/секретов.

Export Composer: **что → состав пакета → куда → сводка и одно действие**.
Confluence scope: страница / поддерево / пространство / фрагмент; Jira: задача / поиск /
доступный HTML-фрагмент. Для других доступных страниц остаётся DOM picker без roundtrip.
Выбор корня дерева не навигирует источник; открытие страницы — отдельное действие.

Три обязательных назначения: **Скачать ZIP**, **Новая папка**, **ZIP непосредственно на диск**.
Большие/многостраничные операции и оба filesystem mode работают в обычной extension tab
с закреплённым источником. Panel остаётся для быстрого одностраничного ZIP и явно открывает
рабочую вкладку для остальных случаев; скрытых fallback после отказа/отмены picker нет.

### Defaults, draft и run — разные состояния

- `exportDefaults` v5 хранит три шаблона, package toggles, conversion rules и глубину.
- Одноразовый draft не меняет defaults без отдельной команды сохранения.
- `PreparedExport` фиксирует source, effective rules, network options и destination.
- Source-scoped workspace хранит scope/root/search/filter/expanded state, не HTML/Blob/handles.
- Одна живая задача принадлежит surface owner под Web Lock; snapshot не даёт fake resume/cancel.
- Старые namespace IDs нормализуются на границе чтения; пользовательские rules payload не теряются.

### Gates приёмки

| Область              | Обязательное доказательство                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy              | Внешний проверенный backup; synthetic-only fixtures; отдельный history/artifact/media audit без приватного denylist в репозитории      |
| Декомпозиция         | Producers, package writer, ZIP encoder и paths без второго pipeline, React/download UI в core и старых re-export paths                 |
| Без массовой записи  | Отсутствует bulk route/API/publisher; single-editor export → local edit → diff → confirm → apply без публикации работает               |
| Настройки            | Append-only v4→v5, forward-version preservation, defaults отдельно от draft/run, нет мёртвых flattened keys                            |
| Рабочее пространство | Scope/root/filter/expanded/draft и рабочий cancel сохраняются при смене раздела; источник не заменяется активной вкладкой              |
| Полнота и запись     | Хвосты 201/6001, первая запись раньше последнего fetch, только текущая page payload, canonical resource links и честные failures       |
| Три назначения       | Общий fflate encoder, ZIP32 guards, реальные directory/streamed writable, корректные close/abort/download completion                   |
| Launcher             | Drag/snap, hide на document/site, live settings и restore; скрытая кнопка не возвращается после SPA rerender                           |
| File import          | Web Panel → normal extension tab → native file input → diff → apply; Vivaldi проверяется отдельно                                      |
| Выпуск               | Актуальные Chrome/Yandex build, unit/contracts/actual-extension E2E, OS-picker smoke, privacy/quality gates, правильный корень ZIP/CRX |
| Production Composer  | Одна форма what/package/destination/summary, одно основное действие и один JobStatus; 320/350/600/1120px, keyboard, обе темы              |
| Options              | Единственная options page, advanced свёрнут; реальные network/rules JSON controls, безопасная диагностика только явным действием       |
| CI                   | Privacy/type/unit/contracts/lint/format, свежий Chrome build+E2E, unsigned Yandex build; Release зависит от общего verification          |

### Ограничения результата

Численное ускорение и heap threshold не обещаются без измерения. Disk modes не держат
весь compressed output, но converter материализует текущую страницу с её ресурсами;
Jira search сохраняет aggregate text/JSON. При фатальном page failure ZIP не выдаётся
за готовый результат; directory оставляет закрытые файлы и terminal marker без recursive rollback.

Применение editable не публикует страницу. Native OS pickers Chrome/Vivaldi/Yandex не считаются
проверенными по OPFS mock или screenshot. Tag, push и release требуют отдельного разрешения;
очистка remote-истории отдельно проходит leases и Release-workflow safety gate.

Уточнение native-приёмки: по решению оператора цикл завершается после полного сценария
в одном браузере; выбран Vivaldi на macOS. Непроверенные OS-сценарии Chrome/Yandex
не засчитываются и не объявляются поддержанными по одной лишь OPFS-автоматизации.

В directory создаётся свежий `<safe-actual-package-root>-<job-UUID>` и
`.confx-export.json` с running/terminal state и сырыми подтверждёнными счётчиками.
Отмена оставляет закрытые файлы и marker, не удаляет дерево. Streamed ZIP также выбирает
родительскую папку до асинхронного извлечения, затем создаёт новый
`<safe-actual-package-root>-<job-UUID>.zip` по фактическому корню producer, не подсказке
черновика. Готовность — только после завершения encoder, всех записей и close writable;
отмена/ошибка может оставить новый ZIP незавершённым, без удаления и ложной готовности.
Коллизия с файлом или папкой отклоняется до открытия writable: существующее не
переиспользуется, не очищается и не перезаписывается.

`showSaveFilePicker` исключён из streamed ZIP: нормативный алгоритм
[WICG File System Access](https://wicg.github.io/file-system-access/#api-showsavefilepicker)
очищает выбранный существующий файл до возврата handle, а не из-за особой ошибки Vivaldi.
Новый контракт избегает выбора старого файла вообще, вместо обещания восстановить его
байты после abort. На актуальной сборке Vivaldi подтверждены оба выбора родительской
папки, новый читаемый ZIP после close и отмена без изменения соседних существующих
файлов. Обычный Download ZIP с окном сохранения браузера и raw-directory в свежем
подкаталоге не меняются. После исправления пустой initial navigation подтверждён настоящий
production fallback popup → «Выбрать файл во вкладке» → normal workspace → native file →
diff/apply с отдельным подтверждением. Старый baseline корректно отклонён без записи;
свежий экспорт текущего редактора применил только выбранный блок, published storage/version не менялись.
Точный native toolbar/SidePanel/WebPanel probe не подменяется popup: исходный ручной клик
открыл пустую панель, а удаление тестового allowlist-флага не устранило сбой. После штатной
установки через Developer Mode → Load unpacked настоящий native UI Vivaldi отрисован
до подключения CDP. Установка и момент подключения отладчика изменены одновременно:
причина исходной пустой панели отдельно не установлена. После исправления surface binding
подтверждён точный путь native Update page → Choose file in workspace → новая normal tab
с закреплённым источником → настоящий OS input → diff одного блока → отдельный confirm/apply.
Изменён только выбранный Lorem-блок; published storage байт-в-байт прежний, версия 1.
Свежий экспорт текущего редактора без правок загружен через OS input как unchanged:
Apply выключен, HTML редактора не изменён. В настоящем native запросе доступа к папке
нажат «Не разрешать»: существующий sentinel сохранён, новых файлов/download fallback нет,
picker завершён, блокировки отпущены, ложной готовности нет.
Vivaldi может возвращать скрытую pseudo-tab панели из `tabs.getCurrent()`: workspace
получает только собственная реальная вкладка из `tabs.query` с URL исполняемого документа.
Скрытая pseudo-tab сохраняет native surface, HTTP-вкладка не получает права workspace.
Общие ZIP32 guards консервативно ограничивают 65 534 записи и `0xfffffffe` байт;
превышение — `ZIP_LIMIT_EXCEEDED`, а не готовый архив. Directory ZIP32 cap не получает.

Launcher: один control до 40px, drag ≥6px/snap 12px, document-hide переживает SPA,
site overrides/позиция остаются локально в `cx.launcher.v1`. Restore сохраняет позицию,
reset удаляет site override, но tab-hide снимается только reload. Global toggles — live.

Unsigned Yandex build использует существующую public identity без private key.
Только signed CRX packaging требует существующий signing key; отсутствие ключа — блокер,
не повод генерировать новую identity. Наличие CI кода не доказывает прохождение gates.


## Resource quality в рамках R2

PlantUML и обычные ресурсы проверяются в одном последовательном package pipeline:
фактически записанные canonical paths, collision/dedup policy, локальные ссылки на
существующие файлы, сохранение online URL при resource failure и partial manifest.
Comment ownership и пары PNG/source остаются раздельными. Это read-only quality gate,
не второй product plan и не будущий publishing workflow.

## Toolbar icon — чёткое artwork и оформление

Плоский документ со стрелкой, без свечения и градиентов. PNG 16/20/24/32/40/48/64 px
отрисованы по собственной pixel grid для Light/Dark и пяти палитр; генератор берёт цвета
из общих appearance tokens. Action icon получает абсолютные extension URL, поскольку
относительные пути из вложенного service worker приводили к настоящему `Failed to fetch`.

System: одноразовый offscreen sample закрывается сразу после чтения; живые изменения
приходят из видимой HTTP(S)-страницы с content script или видимого окна ConfX.
На внутренних страницах браузера обновление ждёт следующую подходящую видимую страницу.
Статичная иконка extension manager не подменяется обещанием динамической.

Проверено: 1172 unit tests, 65 sandbox contracts, 50 browser E2E; обе target-сборки,
typecheck, formatting и privacy check прошли. ESLint — без ошибок, 23 предупреждения.
В реальном Chromium все десять mode/palette комбинаций прошли настоящий `action.setIcon`;
System меняется с видимой веб-страницы при закрытых окнах ConfX, не меняя settings.
В отдельном headed Chromium подтверждены native Light/Blue и Dark/Forest,
а при единственной открытой `chrome://extensions/` одноразовый sample вернул Dark,
сразу закрылся и сохранил соответствующую иконку. Временный browser profile удалён.
Git-история и release-артефакты не изменялись; Vivaldi нужно штатно перезагрузить расширение.

## Leak-control gate перед 0.3.0 — 2026-11-22

Контрольная проверка перед выпуском: секреты и приватные данные, передача данных в коде,
жизненный цикл ресурсов и зависимости.

- Viewer рендерит только пассивный HTML (DOMPurify allowlist); alt/labels/destinations
  кодируются до Markdown. Правки редактора идут в browser-owned `documentId` после
  ISOLATED-probe, с AbortSignal и без unpinned fallback. Фатальная ошибка параллельного
  чтения отменяет соседние запросы и удерживает lock до их завершения; failed job
  прерывает оставшуюся работу; viewer отменяет чтение при unmount. Console-логи ресурсов
  содержат только reason/status.
- Зависимости: Vite 7.3.8, Vitest 4.1.12, plugin-react 4.7.0, DOMPurify 3; `npm audit` — 0.
- Рабочее дерево кандидата: без JWT, реальных e-mail, домашних путей, IP, ключей и ключей
  реальных проектов; gitleaks по кандидату — 0 находок.
- История: в опубликованных коммитах main и старых локальных ветках остались прежние
  capture-фикстуры. Обезличенный triage — локально в `tests/reports/leak-audit/` (не
  публикуется). Решение оператора: 0.3.0 публикуется одним коммитом поверх origin/main
  без отправки старых коммитов; переписывание истории — отдельный согласованный этап.
