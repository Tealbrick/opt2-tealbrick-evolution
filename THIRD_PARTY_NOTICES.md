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

## Workflow engine (C367, WP2): Temporal TypeScript SDK and its dependencies

`@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow` and `@temporalio/activity` are pinned to ONE exact version,
**1.24.0** (published 2026-09-15; `@temporalio/testing` 1.24.0 is a development dependency). All are MIT
(https://github.com/temporalio/sdk-typescript). The workflow code is bundled once at build time
(`scripts/build-workflows.ts`) with the webpack and SWC that `@temporalio/worker` depends on; the image keeps them because
the worker package declares them.

| Name | Version | Licence | Source |
|---|---|---|---|
| `@temporalio/client`, `worker`, `workflow`, `activity` | 1.24.0 | MIT | https://github.com/temporalio/sdk-typescript |
| `@temporalio/common`, `proto`, `core-bridge` (native Core SDK binary), `nexus` | 1.24.0 | MIT | https://github.com/temporalio/sdk-typescript |
| `@grpc/grpc-js`, `@grpc/proto-loader`, `protobufjs`, `@protobufjs/*`, `long`, `rxjs` | 1.14.6 / 0.8.1 / 7.6.6 and 8.8.1 / - / 5.3.2 / 7.8.2 | Apache-2.0, BSD-3-Clause | https://github.com/grpc/grpc-node, https://github.com/protobufjs/protobuf.js |
| `webpack`, `swc-loader`, `source-map-loader`, `terser` and their dependencies | 5.112.2 / 0.2.7 / 5.0.0 / 5.51.2 | MIT, BSD-2-Clause | https://github.com/webpack/webpack |
| `@swc/core` (+ the platform binary) | 1.16.20 | Apache-2.0 (the binary: Apache-2.0 AND MIT) | https://github.com/swc-project/swc |
| `memfs`, `unionfs`, `@jsonjoy.com/*`, `fs-monkey` | 4.80.0 / 4.6.0 / - / 1.1.0 | Apache-2.0, MIT (`unionfs`: Unlicense text in its `LICENSE`), Unlicense | https://github.com/streamich/memfs |
| `caniuse-lite` (browser data used by `browserslist`) | 1.0.30001819 | CC-BY-4.0 | https://github.com/browserslist/caniuse-lite |
| `tslib` | 2.8.1 | 0BSD | https://github.com/microsoft/tslib |

The full list of the 155 production packages (`pnpm licenses list --prod`) has only these licence classes: MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, CC-BY-4.0 (data only) and the Unlicense text of `unionfs`. No copyleft licence.

The Temporal SERVER is not part of this app image: it runs as the companion service `temporal` (WP1; Temporal CLI, MIT).

## Base image

`node:24-slim` (Dockerfile): Node.js (MIT, with bundled components under their own licences) on Debian (the licences of
its packages are in `/usr/share/doc/*/copyright` inside the image).

## Development only (not shipped)

TypeScript, Biome, `@types/*`, happy-dom and `@opt2-tealbrick/conformance` are used to build and test the app and are
not part of the image.
