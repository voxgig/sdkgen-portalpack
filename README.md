# @voxgig/sdkgen-portalpack

**Developer-portal targets** for the
[Voxgig SDK Generator](https://github.com/voxgig/sdkgen): generate a mock of
your API from the same model as its SDK, with realistic data and API keys,
served on Fastify or on Cloudflare Workers.

> **Status: placeholder.** Version 0.0.1 reserves the package name so that
> releases can be published by GitHub Actions with npm trusted publishing.
> It contains no targets yet. Do not install it.

The design is in [docs/design/devapi.md](docs/design/devapi.md):

| target | produces |
|---|---|
| `devapi-data` | Mock data defined in aontu, as CSV and JSON, a typed interface, and a Seneca plugin that serves a copy of the data to each account. |
| `devapi-access` | API-key generation and validation, and the accounts keys are issued under. |
| `devapi-fastify` | A mock server on Fastify, with SQLite storage. |
| `devapi-cloudflare` | The same server on Cloudflare Workers with Astro, with D1 storage. |

## License

MIT
