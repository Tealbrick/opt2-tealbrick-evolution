# Third-party notices

This app's own code is Apache-2.0 (see `LICENSE` and `NOTICE`). It includes the software and assets below under their own
licences. Update this file when you add a dependency, a vendored file or a companion image.

## Vendored into the built UI (`dist/ui`)

The UI build (`scripts/build-ui.ts`) copies these files into the app image.

| Name | Version | Licence | Source |
|---|---|---|---|
| React (`react`) | 19.3.0 | MIT | https://github.com/facebook/react |
| React DOM (`react-dom`) | 19.3.0 | MIT | https://github.com/facebook/react |
| `scheduler` | 0.28.0 | MIT | https://github.com/facebook/react |
| `@opt2-tealbrick/ui` (Tealbrick design system kit: tokens, components, CSS) | 0.2.4 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-packages |
| `@opt2-tealbrick/miniapp-sdk/client`, `@opt2-tealbrick/spec/bridge` and `@opt2-tealbrick/spec/routes` (browser modules only) | 0.1.31 / 0.1.47 | Tealbrick Software Licence 1.1 | see the next section |
| Nunito (variable font, `vendor/@opt2-tealbrick/ui/dist/fonts/*.woff2`) | 5.3.0 (`@fontsource-variable/nunito`) | SIL Open Font License 1.1 | https://github.com/googlefonts/nunito |

- Nunito is Copyright 2014 The Nunito Project Authors. Its licence text ships next to the font files as
  `vendor/@opt2-tealbrick/ui/dist/fonts/OFL.txt`.
- The Tealbrick brand mark and the app stills (`stills/*.webp`, from `@opt2-tealbrick/ui` `assets/`) are Tealbrick
  artwork. They are **not** covered by the Apache-2.0 licence of this app and are not licensed for reuse outside
  Tealbrick products.

## Runtime dependencies in the image (production `node_modules`)

| Name | Version | Licence | Source |
|---|---|---|---|
| `@opt2-tealbrick/miniapp-sdk` | 0.1.31 | Tealbrick Software Licence 1.1 (`LICENSE` in the package; earlier versions were MIT) | https://github.com/Tealbrick/opt2-tealbrick-dist |
| `@opt2-tealbrick/manifest` | 0.1.25 | Tealbrick Software Licence 1.1 (`LICENSE` in the package; earlier versions were MIT) | https://github.com/Tealbrick/opt2-tealbrick-dist |
| `@opt2-tealbrick/spec` (direct dependency; the manifest package also nests 0.1.46) | 0.1.47 | Tealbrick Software Licence 1.1 (`LICENSE` in the package; earlier versions were MIT) | https://github.com/Tealbrick/opt2-tealbrick-dist |
| `ajv` (dependency of the manifest package) | 8.17.1 | MIT | https://github.com/ajv-validator/ajv |
| `fast-deep-equal` (ajv) | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| `fast-uri` (ajv) | 3.1.8 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| `json-schema-traverse` (ajv) | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| `require-from-string` (ajv) | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |

## Base image

`node:24-slim` (Dockerfile): Node.js (MIT, with bundled components under their own licences) on Debian (the licences of
its packages are in `/usr/share/doc/*/copyright` inside the image).

## Companion service image `temporal` (`services/temporal/Dockerfile`)

| Name | Version | Licence | Source |
|---|---|---|---|
| Temporal CLI (`temporal`, with the embedded Temporal server 1.32.0 and its dev-server SQLite persistence; the Web UI is not started) | 1.9.1 | MIT (`/usr/share/doc/temporal-cli/LICENSE` in the image) | https://github.com/temporalio/cli |
| SQLite command-line shell (`sqlite3`, Debian package) | Debian bookworm | Public domain | https://www.sqlite.org |
| `@opt2-tealbrick/miniapp-sdk` (the `tb-exec` entrypoint only) | 0.1.31 | Tealbrick Software Licence 1.1 | https://github.com/Tealbrick/opt2-tealbrick-dist |
| Node.js and Debian base (`node:24.22.1-bookworm-slim`) | 24.22.1 | see "Base image" | https://hub.docker.com/_/node |

## Development only (not shipped)

TypeScript, Biome, `@types/*`, happy-dom and `@opt2-tealbrick/conformance` are used to build and test the app and are
not part of the image. The smoke and measurement scripts under `smoke/` use the Temporal TypeScript SDK (`@temporalio/client`, `worker`, `workflow`, `activity` 1.24.0, MIT, https://github.com/temporalio/sdk-typescript); WP2 ships the same version in the app.
