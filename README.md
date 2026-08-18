# @hiq-ai/hiq-cortex-cli

Command-line client for **HiQ Cortex** — look up real LCA emission factors from
18 life-cycle inventory databases (ecoinvent, BAFU, USLCI, ELCD, EF, worldsteel,
HiQLCD …) and 24,000+ published EPDs.

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
curl -fsSL https://raw.githubusercontent.com/HiQ-AI/hiq-cortex-cli/main/scripts/install.sh | sh
```

**Windows**

```powershell
irm https://raw.githubusercontent.com/HiQ-AI/hiq-cortex-cli/main/scripts/install.ps1 | iex
```

Both installers detect the platform, verify the checksum, and drop `hiq-cortex`
into a per-user directory (`~/.local/bin`, `%LOCALAPPDATA%\Programs\hiq-cortex`)
— no sudo, no admin. `HIQ_CORTEX_VERSION`, `HIQ_CORTEX_INSTALL` and
`HIQ_CORTEX_BASE_URL` (mirror origin) override the defaults.

Prebuilt binaries for macOS (arm64 / x64), Linux (x64 / arm64) and Windows (x64)
are also attached to every [release](https://github.com/HiQ-AI/hiq-cortex-cli/releases)
directly, with a checksums file.

**Where Node is already there** — agent hosts, CI, an existing project — the same
CLI ships on npm, which skips the download step entirely:

```bash
npx @hiq-ai/hiq-cortex-cli doctor
```

## Quick start

```bash
hiq-cortex login              # QR sign-in, no registration needed
hiq-cortex search "304 不锈钢"
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
hiq-cortex search "<你的原话>" [--sources BAFU,Ecoinvent]   # 材料 / BOM 行 → 候选数据集
hiq-cortex list                       # 全部子命令(--json 出 schema)
hiq-cortex describe aggregate-datasets   # 某个子命令的参数
hiq-cortex doctor                     # 凭据来源 + 连通性自检
hiq-cortex login / logout
```

Beyond `search`, subcommands are **generated at runtime from the server's tool
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

Escape hatch: `hiq-cortex call <native_tool_name> --args '<json>'`.

`search` takes 20–40 seconds — the server searches the catalogs and verifies
every hit. That is normal, not a hang; retrying in parallel only adds load.

## Credentials

Two ways, env wins when both are present:

```bash
hiq-cortex login             # 浏览器点一次授权,凭据存 ~/.config/hiq-cortex/credentials.json (600)
export HIQ_API_KEY=sk_xxx    # 服务端 / CI
```

Sign-in returns your own SSO credential, so the visible data scope equals your
account's — **including any commercial databases you have entitlements for**.
`logout` removes the stored file.

Credentials from the older Python client (`~/.hiq/credentials.json`) are still
read, so you don't have to sign in again after switching.

## Output contract

Human-readable text by default. `--json` for machines:

- stdout on success: `{"ok":true,"tool":…,"text":…}`（`search` 用 `data` 带结构化行）
- stderr on failure: `{"ok":false,"kind":…,"message":…}`

Exit codes — branch on these rather than parsing messages:

| Code | Meaning |
|---|---|
| `0` | ok |
| `2` | 缺凭据 → 跑 `login` |
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
npm run build       # tsc → dist/ (the npm channel)
npm run dev         # tsx src/cli.ts
npm run build:bin   # bun --compile → dist-bin/ (every platform, needs bun)
```

`build:bin` cross-compiles all five targets from whichever machine runs it;
only the Darwin binaries need a Mac, to be codesigned. Releases build them on a
macOS runner for that reason.

The version lives in `package.json` alone — `prebuild` stamps it into
`src/version.ts`, because a single-file binary has no manifest to read at
runtime.

## License

[Apache-2.0](LICENSE)
