# Yandex signing key notes

ConfX uses a private signing key to create `release/confx-yandex.crx` for direct Yandex Browser installation.

## Summary

- Local development key path: `keys/yandex.pem`.
- CI key source: `YANDEX_CRX_PRIVATE_KEY_B64` GitHub Actions secret.
- Expected release extension ID: `cjhpodjghfokdfoljmfbgibjjfpafdip`.
- Losing the release key means future CRX builds get a different extension identity.
- Leaking the release key allows someone else to create builds with the same extension identity.

## Local development

Developers can create their own local key:

```sh
npm run gen:key:yandex
```

That key is suitable for local testing only. It produces a different extension ID unless it is the official release key.

## Release key handling

Use one shared release key for artifacts distributed to users. Store it only in a secret manager and GitHub Actions secrets.

Recommended GitHub Actions setup:

1. Store the base64-encoded private key as `YANDEX_CRX_PRIVATE_KEY_B64`.
2. Keep `YANDEX_EXTENSION_ID` set to `cjhpodjghfokdfoljmfbgibjjfpafdip`.
3. Let the release workflow write the key to a temporary file.
4. Delete the temporary file at the end of the workflow.

Do not paste the private key into Markdown, issues, pull requests, chat, or logs. Documentation should describe the PEM format in words instead of including literal private-key boundary markers.

## Validation

`scripts/pack-yandex.mjs` computes the Yandex extension ID from the signing key. When `YANDEX_EXTENSION_ID` is set, packaging fails if the computed ID does not match.

Local release validation:

```sh
YANDEX_EXTENSION_ID=cjhpodjghfokdfoljmfbgibjjfpafdip npm run release:yandex
```

## If the key is lost

Restore it from the team secret manager. If no backup exists, a new key creates a new extension ID, and existing users will see the build as a different extension.

## If the key may have leaked

Stop distributing builds signed with the leaked key, generate a new release key, and communicate the extension ID change to users. Browser storage migration may require manual handling.
