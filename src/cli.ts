#!/usr/bin/env node
/**
 * `hiq-cortex` — command-line client for HiQ Cortex LCA data.
 *
 * Subcommands come from two places:
 *   • `search` — REST + SSE, the material → dataset step (see search.ts)
 *   • everything else — generated at runtime from the server's tool catalog,
 *     so there is no schema copy here to drift when the server adds a field.
 *
 * Output contract (agents depend on it): human text by default; `--json` puts
 * `{"ok":true,…}` on stdout and `{"ok":false,"kind":…,"message":…}` on stderr.
 * Exit codes: 0 ok · 2 config · 3 validation · 4 upstream · 5 transport · 1 unknown.
 */
import yargs from "yargs";

import { config, hasCredential } from "./config.js";
import { registerToolCommands, toolAlias, type CatalogTool } from "./dynamicCommands.js";
import { credentialsPath, runLogin, runLogout } from "./login.js";
import { callTool, listTools } from "./mcpClient.js";
import { RENDERERS } from "./format.js";
import { formatSearch, runSearch } from "./search.js";
import { formatVerifyFlows, parseFlowsArg, runVerifyFlows } from "./verifyFlows.js";
import { formatSearchFlows, parseQueriesArg, runSearchFlows } from "./searchFlows.js";
import { CortexClientError, EXIT, exitCodeFor } from "./types.js";
import { VERSION } from "./version.js";

const STATIC = new Set(["search", "list", "describe", "call", "doctor", "login", "logout", "version"]);

function emit(json: boolean, tool: string, text: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, tool, text }) + "\n");
    return;
  }
  // Render the payloads a person actually reads; print the rest as-is.
  const rendered = RENDERERS[tool]?.(text);
  process.stdout.write((rendered ?? text) + "\n");
}

function fail(json: boolean, err: unknown): never {
  const e =
    err instanceof CortexClientError
      ? err
      : new CortexClientError("unknown" as never, (err as Error)?.message ?? String(err));
  process.stderr.write(
    json
      ? JSON.stringify({ ok: false, kind: e.kind, message: e.message, code: e.code }) + "\n"
      : `${e.message}\n`,
  );
  process.exit(exitCodeFor(e));
}

async function catalog(): Promise<CatalogTool[]> {
  const tools = await listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    local: false,
  }));
}

async function main(): Promise<void> {
  // NOT hideBin(): a host running us under ELECTRON_RUN_AS_NODE still reports
  // `process.versions.electron` with `process.defaultApp` unset, which makes
  // yargs think it is a packaged Electron app and strip only argv[0] — the
  // script path then survives as a positional and every command fails. This
  // CLI always starts as `<runtime> cli.js …`, so argv[2:] is right for plain
  // node, Electron-as-node, and the bun-compiled binary alike. (Bit us for
  // real in @hiq-ai/hiq-editor 0.9.3.)
  const argvRaw = process.argv.slice(2);
  const json = argvRaw.includes("--json");

  // Tool subcommands need the server catalog. Only fetch it when the first
  // non-flag arg isn't one of the static commands — keeps `login` usable with
  // no credential, and keeps `--help` fast.
  const first = argvRaw.find((a) => !a.startsWith("-"));
  let tools: CatalogTool[] = [];
  if (first && !STATIC.has(first) && hasCredential()) {
    try {
      tools = await catalog();
    } catch {
      /* fall through: yargs will report the unknown command */
    }
  }

  const cli = yargs(argvRaw)
    .scriptName("hiq-cortex")
    .usage("$0 <command> [options]")
    .option("json", { type: "boolean", default: false, describe: "机器可读输出" })
    .command(
      "search <query>",
      "材料 / BOM 行 → 候选数据集(20–40 秒,服务端要检索并逐条校验)",
      (y) =>
        y
          .positional("query", { type: "string", describe: "用户的原话,不用先翻译成 LCA 术语" })
          .option("sources", { type: "string", describe: "限定数据库,逗号分隔(如 BAFU,Ecoinvent)" }),
      async (a) => {
        try {
          const r = await runSearch(String(a.query), a.sources as string | undefined);
          if (a.json) process.stdout.write(JSON.stringify({ ok: true, tool: "search", data: r }) + "\n");
          else process.stdout.write(formatSearch(r) + "\n");
        } catch (e) {
          fail(Boolean(a.json), e);
        }
      },
    )
    .command(
      "verify-flows",
      "核验基本流 id(可带单位)是否在某源某版本的目录里 —— 给数据集制作当判据,不是查数",
      (y) =>
        y
          .option("source", { type: "string", demandOption: true, describe: "源 code,如 hiqlcd / ecoinvent" })
          // 不叫 --version:那是 yargs 全局的「打印 CLI 版本」,会把值吃成未知参数。与 search 结果字段 src/ver 同名法。
          .option("ver", { type: "string", demandOption: true, describe: "坐标版本,如 1.5.0(必填:核验按坐标)" })
          .option("flows", {
            type: "string",
            demandOption: true,
            describe: "id[:unit],id[:unit],… 或 @file(JSON 数组,元素为字符串或 {id, unit})",
          }),
      async (a) => {
        try {
          const r = await runVerifyFlows(String(a.source), String(a.ver), parseFlowsArg(String(a.flows)));
          if (a.json) process.stdout.write(JSON.stringify({ ok: true, tool: "verify-flows", data: r }) + "\n");
          else process.stdout.write(formatVerifyFlows(r) + "\n");
          // 有缺 / 单位不符 → 退出码 2,让脚本不用解析就能判「没全对」
          if (r.missing > 0 || r.unitMismatch > 0) process.exit(2);
        } catch (e) {
          fail(Boolean(a.json), e);
        }
      },
    )
    .command(
      "search-flows",
      "检索基本流候选(名 / 同义词 / CAS / 化学式 BM25 + 向量)—— 给数据集制作的 H 列当候选源",
      (y) =>
        y
          .option("source", { type: "string", demandOption: true, describe: "源 code,如 hiqlcd / ecoinvent" })
          .option("ver", { type: "string", demandOption: true, describe: "坐标版本,如 1.5.0" })
          .option("queries", { type: "string", demandOption: true, describe: "q1,q2,… 或 @file(JSON 数组,元素为字符串或 {query, compartment})" })
          .option("limit", { type: "number", default: 5, describe: "每个 query 回几条(1..50)" }),
      async (a) => {
        try {
          const r = await runSearchFlows(String(a.source), String(a.ver), parseQueriesArg(String(a.queries)), Number(a.limit));
          if (a.json) process.stdout.write(JSON.stringify({ ok: true, tool: "search-flows", data: r }) + "\n");
          else process.stdout.write(formatSearchFlows(r) + "\n");
        } catch (e) {
          fail(Boolean(a.json), e);
        }
      },
    )
    .command("list", "列出全部子命令(--json 出 schema)", {}, async (a) => {
      try {
        const t = await catalog();
        if (a.json) {
          process.stdout.write(JSON.stringify({ ok: true, tools: t }) + "\n");
        } else {
          const lines = ["search    材料 / BOM 行 → 候选数据集"];
          for (const x of t) lines.push(`${toolAlias(x.name).padEnd(24)}${(x.description ?? "").split("\n")[0]}`);
          process.stdout.write(lines.join("\n") + "\n");
        }
      } catch (e) {
        fail(Boolean(a.json), e);
      }
    })
    .command("describe <tool>", "看某个子命令的参数说明", (y) => y.positional("tool", { type: "string" }), async (a) => {
      try {
        const t = await catalog();
        const hit = t.find((x) => toolAlias(x.name) === a.tool || x.name === a.tool);
        if (!hit) throw new CortexClientError("validation", `未知子命令: ${a.tool}(用 list 看全部)`);
        process.stdout.write(JSON.stringify(hit, null, 2) + "\n");
      } catch (e) {
        fail(Boolean(a.json), e);
      }
    })
    .command(
      "call <tool>",
      "直接调服务端工具(逃生舱)",
      (y) =>
        y
          .positional("tool", { type: "string" })
          .option("args", { type: "string", default: "{}", describe: "JSON 参数对象" }),
      async (a) => {
        try {
          const parsed = JSON.parse(String(a.args)) as Record<string, unknown>;
          emit(Boolean(a.json), String(a.tool), await callTool(String(a.tool), parsed));
        } catch (e) {
          fail(Boolean(a.json), e);
        }
      },
    )
    .command("doctor", "凭据来源 + 连通性自检", {}, async () => {
      const src = config.apiKey ? "HIQ_API_KEY(环境变量)" : config.ssoToken ? `login 凭据(${credentialsPath()})` : "无";
      const lines = [`版本:   ${VERSION}`, `API:    ${config.base}`, `凭据:   ${src}`];
      if (!hasCredential()) {
        lines.push("", "还没有凭据 —— 跑 `hiq-cortex login`(浏览器点一下,无需注册)。");
        process.stdout.write(lines.join("\n") + "\n");
        process.exit(EXIT.config);
      }
      try {
        const t = await catalog();
        lines.push(`连通:   正常,服务端发布了 ${t.length} 个工具`);
        process.stdout.write(lines.join("\n") + "\n");
      } catch (e) {
        lines.push(`连通:   失败 —— ${(e as Error).message}`);
        process.stdout.write(lines.join("\n") + "\n");
        process.exit(EXIT.transport);
      }
    })
    .command("login", "扫码登录(无需注册,浏览器点一下)", {}, async (a) => {
      try {
        await runLogin(Boolean(a.json));
      } catch (e) {
        fail(Boolean(a.json), e);
      }
    })
    .command("logout", "删除本机存储的凭据", {}, (a) => runLogout(Boolean(a.json)))
    .command("version", "打印版本", {}, () => {
      process.stdout.write(VERSION + "\n");
    });

  const withTools = registerToolCommands(
    cli,
    tools,
    async (toolName, args) => emit(json, toolName, await callTool(toolName, args)),
    (err) => fail(json, err),
  );

  // .version(VERSION) is explicit on purpose: left to itself yargs walks up the
  // filesystem looking for a package.json, which a single-file binary has not got.
  await withTools.demandCommand(1).strict().help().alias("h", "help").version(VERSION).parse();
}

main().catch((e) => fail(process.argv.includes("--json"), e));
