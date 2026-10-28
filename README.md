# LCA Background Data

`lca-background-data` searches LCA background databases and matches material,
energy, transport, treatment and other inventory requirements to **process
datasets**. Inputs can be a single description, inventory item or supported batch,
not only a BOM. Databases such as ecoinvent or CLCD are background sources, not
individual datasets; actual availability and numerical access come from the service.

Published-EPD lookup tools can supply supplementary product evidence, but an EPD
is not automatically an interchangeable background process dataset. This CLI does
not perform EPD compliance review, certification or local LCA calculation.

Carbon-footprint answers have to come from real inventory data. A remembered
"steel is about 2 kg CO₂e/kg" is useless to an LCA practitioner: the real value
depends on database, version, system model, production route and geography, and
varies several-fold across those dimensions. This CLI gets you the actual number
**with its basis and a link back to the dataset**.

Apache-2.0. The client is thin — search, ranking and match-quality scoring all
run server-side; this package posts your query and renders what comes back.

## Install

A single self-contained executable — nothing else has to be on the machine, no
Node, no Python, no runtime of any kind.

**macOS / Linux**

```bash
curl -fsSL https://download.hiq.earth/cli/lca-background-data/install.sh | sh
```

**Windows**

```powershell
irm https://download.hiq.earth/cli/lca-background-data/install.ps1 | iex
```

Served from a CDN that is reachable from mainland China, where github.com and
raw.githubusercontent.com are both blocked; GitHub Releases stays the source of
truth and mirrors within a minute of each tag.

Both installers detect the platform, verify the checksum, and drop `lca-background-data`
into a per-user directory (`~/.local/bin`, `%LOCALAPPDATA%\Programs\lca-background-data`)
— no sudo, no admin. `LCA_BACKGROUND_DATA_VERSION`, `LCA_BACKGROUND_DATA_INSTALL` and
`LCA_BACKGROUND_DATA_BASE_URL` (mirror origin) override the defaults.

Prebuilt binaries for macOS (arm64 / x64), Linux (x64 / arm64) and Windows (x64)
are also attached to every [release](https://github.com/HiQ-AI/hiq-cortex-cli/releases)
directly, with a checksums file.

This CLI identity is distributed as native binaries, not a new npm package.
`package.json` is private build metadata; local package-install tests do not
publish it. Existing old-name npm versions and v0.4.2 assets remain untouched.
The new command, configuration and login store have no old-name fallback or alias.

## Quick start

```bash
lca-background-data login              # QR sign-in, no registration needed
lca-background-data search "304 不锈钢"
```

```
▸ 中厚板, 304不锈钢,混合技术   [匹配度 medium]
  参考流: 中厚板, 304不锈钢   单位: kg
  基准:   HiQLCD · 1.5.0 · CUT_OFF · CN
  GWP:    5.2839 kg CO2-Eq
  链接:   https://www.hiqlcd.com/dataset/HiQLCD/1.5.0/CUT_OFF/...
```

Every row carries its **basis** (database · version · system model · geography)
and a **link** to the dataset page. A number without its basis is not usable.

## Commands

```bash
lca-background-data search "<你的原话>" [--sources BAFU,Ecoinvent]   # 材料 / BOM 行 → 候选数据集
lca-background-data search-datasets --source hiqlcd --ver 1.5.0 --model CUT_OFF --queries "电力,天然气" # 确定性目录候选(低延迟)
lca-background-data verify-flows --source hiqlcd --ver 1.5.0 --flows "id:kg,id2,…"   # 基本流 id(+单位)核验
lca-background-data search-flows --source hiqlcd --ver 1.5.0 --queries "二氧化碳,天然气"   # 基本流候选(BM25+向量,中英)
lca-background-data verify-datasets --source hiqlcd --ver 1.5.0 --datasets "id:kWh,id2,…"   # 上游数据集 id(+模型/单位/下架)核验
lca-background-data list                       # 全部子命令(--json 出 schema)
lca-background-data describe aggregate-datasets   # 某个子命令的参数
lca-background-data doctor                     # 凭据来源 + 连通性自检
lca-background-data login / logout
```

`verify-flows` is for **dataset authoring, not querying**: it checks elementary-flow
ids — and optionally the unit your row uses — against the catalog the calculation
actually reads for that source coordinate (`/api/relic/flows/verify`). Identity is
(name, compartment, unit); a uuid alone cannot tell `sm3` from `m3`, and a wrong id
is silent downstream. `--flows` takes `id[:unit],…` or `@file` (JSON array of strings
or `{id, unit}`); `--ver` is required because verification is per coordinate. Exit 2
when anything is missing or a unit mismatches, so scripts can branch without parsing.
Commercial sources return counts only without an entitlement.

`search-datasets` is the deterministic first pass for dataset authoring. It queries the relic
catalog directly, keeps the canonical `datasetRef`, source/version/model, reference unit and
location variants, and accepts a batch of strings or `{query, locations?, activityTypes?,
identity?}` records through `--queries`. It does no LLM translation or ranking. Use the slower
`search` command only when the direct catalog pass has no defensible candidate.

`search-flows` returns elementary-flow candidates for dataset authoring (column H): relic
`/flows/search`, BM25 over names/synonyms/CAS/formula plus a Qwen3-Embedding vector branch, so a
Chinese item name finds its English catalog entry. `--queries` takes `a,b,…` or `@file` (JSON array
of strings or `{query, compartment?, identity?}`); output keeps input order. `identity` is opaque
correlation metadata: the CLI never sends it to relic and copies it onto the corresponding result,
so an authoring workflow can search with a translated alias without losing the source-row identity.

`verify-datasets` does for upstream dataset ids (UPR column I) what `verify-flows` does for
elementary flows: `/datasets/verify` answers whether the id exists at that coordinate, under which
system models, what its reference unit is and whether it is still published. `--datasets` takes
`id[:unit],…` or `@file` (JSON array of strings or `{id, model?, unit?}`); an id that exists only
under another model comes back `found=false` with `availableModels`. Exit 2 on any missing,
unit-mismatched or unpublished row.

Beyond the static REST commands, tool subcommands are **generated at runtime from the server's tool
catalog** — there is no schema copy in this package to drift when the server
adds a field. At the time of writing:

| Command | What it does |
|---|---|
| `lookup-datasets` | dataset_key → GWP、基准、链接 |
| `aggregate-datasets` | 队列 GWP 分布、百分位定位(行业对标) |
| `aggregate-indicators` | 非 GWP 的 LCIA 指标(酸化、富营养化…) |
| `process-hotspot` | 单数据集的工序级热点 |
| `epd-search` | 检索已发布 EPD(EPDItaly / ECO Platform / EPD Norge) |
| `epd-peer-benchmark` | EPD 同类分布与离群判定 |

Escape hatch: `lca-background-data call <native_tool_name> --args '<json>'`.

`search` takes 20–40 seconds — the server searches the catalogs and verifies
every hit. That is normal, not a hang; retrying in parallel only adds load.

## Credentials

Two ways, env wins when both are present:

```bash
lca-background-data login             # 浏览器点一次授权,凭据存 ~/.config/lca-background-data/credentials.json (600)
export LCA_BACKGROUND_DATA_API_KEY=sk_xxx    # 服务端 / CI
```

Sign-in returns your own SSO credential, so the visible data scope equals your
account's — **including any commercial databases you have entitlements for**.
`logout` removes the stored file.

New logins request `cortex_data` consent, describing LCA data and organization
knowledge reading. The returned credential is the user's full SSO login, not a
technically read-only or Wiki-scoped token; the consent page must state this.
Server authorization still applies to every request. Organization Wiki access is
provided by the independent [cortex-org-wiki CLI and skill](https://github.com/HiQ-AI/cortex-org-wiki-cli).

An absolute `XDG_CONFIG_HOME` selects the native credential store at
`$XDG_CONFIG_HOME/lca-background-data/credentials.json`; otherwise it is
`~/.config/lca-background-data/credentials.json`. Login, use and logout touch only
that store. Old client stores, including `~/.hiq/credentials.json`, are not read,
imported, removed or migrated. Sign in again with the new command.

Configuration uses only `LCA_BACKGROUND_DATA_API_KEY`, `LCA_BACKGROUND_DATA_BASE`,
`LCA_BACKGROUND_DATA_OAUTH_URL` and `LCA_BACKGROUND_DATA_CLIENT_HOST`.
Old-name environment variables are ignored. API and OAuth overrides are separate;
never direct authenticated requests to an unauthorized endpoint. Device login
identifies this client as `lca-background-data`; local fixture tests verify the
request shape, not live consent-page registration or successful user login.

## Output contract

Human-readable text by default. `--json` for machines:

- stdout on success: `{"ok":true,"tool":…,"text":…}`（REST 搜索用结构化 `data`）
- stderr on failure: `{"ok":false,"kind":…,"message":…}`

Exit codes — branch on these rather than parsing messages:

| Code | Meaning |
|---|---|
| `0` | ok |
| `2` | 凭据缺失/失效 |
| `3` | 参数不合法 |
| `4` | 服务端拒绝(含**权益不足**;换参数重试没用) |
| `5` | 连不上服务端 |
| `1` | 未知 |

## Data entitlements

| 层 | 内容 | 要求 |
|---|---|---|
| 目录层 | 18 个库的清单、版本、系统模型、LCIA 覆盖;数据集名称、单位、地域 | 无需权益 |
| 免费库数值 | BAFU、USLCI、ELCD、EF、AusLCI、NEEDS、ozLCI、worldsteel、USDA、bioenergiedat、recycledplastics | 任一有效凭据 |
| 商业库数值 | ecoinvent、HiQLCD、HiQLCD-AL、CALCD、CarbonMinds、Agri-footprint | 需对应数据包权益 |

无权益时返回受限标记与 `purchase_url`（**这不是报错**）。免费库覆盖面不小 ——
BAFU 在欧洲语境下是很好的默认选择，worldsteel 覆盖钢铁，USLCI / USDA 覆盖美国供应链。

## Privacy

- 凭据只从环境变量或 `login` 落盘的文件读取，不写进任何其他地方，也不在输出中回显。
- 查询只发往 `x.hiqlcd.com`（海科数据 API），不发往任何第三方。
- 不收集、不上传本地文件、目录结构或对话内容。

## Development

```bash
npm install
npm run build       # tsc → dist/ for source tests and development
npm test            # build + real CLI/HTTP fixture + clean npm package install
npm run dev         # tsx src/cli.ts
npm run build:bin   # bun --compile → dist-bin/ (every platform, needs bun)
```

`build:bin` cross-compiles all five targets from whichever machine runs it;
only the Darwin binaries need a Mac, to be codesigned. Releases build them on a
macOS runner for that reason.

The version lives in `package.json` alone — `prebuild` stamps it into
`src/version.ts`, because a single-file binary has no manifest to read at
runtime.

CLI lifecycle tests use a loopback OAuth server and fake tokens in temporary
`XDG_CONFIG_HOME` directories. They verify isolated login/logout, local help,
and a clean local package installation, without publishing to npm. They also
check the renamed OAuth identity, ignored old credential stores/variables and API
key precedence. Keep the parent test process's HOME and `XDG_CONFIG_HOME` isolated;
runtime config loads when modules are imported.

## Release contract

New releases are binaries-only. The tag must exactly match the stable numeric
package version and point to main ancestry. A macOS build produces five archives
plus checksums; `scripts/check-native.mjs` checks every archive's digest, member and
executable architecture, then runs version/help/missing-credential doctor for the
native build-host target with an empty identity store. This is not five-platform
execution or successful data access.

The existing verified private draft handoff transfers those exact candidates;
GitHub publication checks every asset and refuses conflicting reruns. npm
publication, registry bootstrap and npm OIDC permissions are not prerequisites
for this new identity. `npm-package` handoff and old npm publisher helpers remain
historical generic utilities, not active release steps.

The CDN mirror uses only the new CLI namespace, verifies checksums and creates
objects conditionally. Identical objects are no-ops; different existing bytes,
including latest/installers, are a hard stop rather than an implicit overwrite.
A later release needs a separately reviewed channel-pointer update if those
stable keys must change. Do not delete old public releases, CDN objects or draft
candidates to force a rerun through. See [.github/RELEASE-HANDOFF.md](.github/RELEASE-HANDOFF.md)
for transport acceptance and retention. Post-publication installer checks pin and
compare the exact version on their runner platforms.

## License

[Apache-2.0](LICENSE)
