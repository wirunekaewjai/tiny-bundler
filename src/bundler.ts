import { compile as compileTailwind } from "@tailwindcss/node";
import { Scanner as TailwindScanner } from "@tailwindcss/oxide";
import { transform as transformCss } from "lightningcss";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import path from "node:path";
import prettier from "prettier";
import { rolldown } from "rolldown";
import { aliasPlugin } from "rolldown/experimental";
import sharp from "sharp";

export type BundlerConfig = {
  assetsDir: string;
  autoReload: boolean;
  backendDir: string;
  backendLanguage?: "rust";
  bundleDir: string;
  frontendAlias: string;
  frontendDir: string;
  templateDir: string;
  tempDir: string;
};

export function defineConfig(config: BundlerConfig) {
  return config;
}

const isProduction = process.env.NODE_ENV === "production";

const command = process.argv[2] as "dev" | "bundle";
const cwd = process.cwd();

const { default: config }: { default: BundlerConfig; } = await import(path.join(cwd, "bundler.config.ts"));

const assetsDir = config.assetsDir;
const backendDir = config.backendDir;
const bundleDir = config.bundleDir;
const frontendDir = config.frontendDir;
const templateDir = config.templateDir;
const tempDir = config.tempDir;

const isAutoReload = config.autoReload && command === "dev";

const backendLanguage = config.backendLanguage;
const frontendAlias = { find: config.frontendAlias, replacement: path.join(cwd, frontendDir) };

const resourceRegex = new RegExp(`["'](${frontendAlias.find}/[^"'*]+)["']`, "g");

const prettierOptions: prettier.Options = {
  parser: "html",
  printWidth: 10_000,
  singleQuote: false,
  useTabs: true,
};

function color(color: Bun.ColorInput, message: string) {
  return `${Bun.color(color, "ansi-16m")}${message}${Bun.color("lightgrey", "ansi-16m")}`;
}

async function bundle() {
  function resolveAlias(input: string): [string, string | undefined] | null {
    try {
      const [alias, querystring] = input.split("?");

      if (alias?.startsWith(frontendAlias.find + "/")) {
        const resolved = path.join(frontendAlias.replacement, alias.slice(frontendAlias.find.length));

        if (existsSync(resolved)) {
          return [resolved, querystring];
        }
      }

    } catch {

    }

    return null;
  }

  function generateHash(input: string | Buffer | ArrayBuffer | Uint8Array<ArrayBufferLike>) {
    return Bun.hash(input).toString(36).slice(0, 8);
  }

  function generateRoute(resourcePath: string, hash: string) {
    const { ext, name } = path.parse(resourcePath);

    const outName = `${name}.${hash}${ext}`;
    const outPath = path.join(cwd, bundleDir, assetsDir, outName);

    const route = `/${assetsDir}/${outName}`;

    return { route, outPath };
  }

  async function processImage(resourcePath: string, querystring: string | undefined) {
    const width = Number(new URLSearchParams(querystring).get("w"));

    let buffer: Buffer | ArrayBuffer = await Bun.file(resourcePath).arrayBuffer();

    if (width && !Number.isNaN(width)) {
      buffer = await sharp(buffer).resize({ width, withoutEnlargement: true }).toBuffer();
    }

    return buffer;
  }

  async function processCss(replacers: Map<string, string>, resourcePath: string) {
    const css1 = await Bun.file(resourcePath).text();
    const compiler = await compileTailwind(css1, {
      base: path.dirname(resourcePath),
      onDependency: (_path) => {
        // console.log(path);
      },
    });

    const scanner = new TailwindScanner({ sources: compiler.sources });
    const candidates = new Set<string>();

    for (const candidate of scanner.scan()) {
      candidates.add(candidate);
    }

    const css2 = compiler.build(Array.from(candidates));
    const css3 = transformCss({
      code: Buffer.from(css2),
      filename: resourcePath,
      minify: isProduction,
    });

    const code = css3.code.toString();

    for (const match of code.matchAll(resourceRegex)) {
      const resourceAlias = match[1] ?? "";

      if (replacers.has(resourceAlias)) {
        continue;
      }

      const resourcePathAndQuery = resolveAlias(resourceAlias);

      if (resourcePathAndQuery) {
        await processFile(replacers, resourceAlias, resourcePathAndQuery);
      }
    }

    let output = code;

    for (const [alias, filePath] of replacers) {
      output = output.replaceAll(alias, filePath);
    }

    return output;
  }

  async function processFile(replacers: Map<string, string>, resourceAlias: string, resourcePathAndQuery: [string, string | undefined]) {
    if (replacers.has(resourceAlias)) {
      return;
    }

    const [resourcePath, querystring] = resourcePathAndQuery;
    const ext = path.extname(resourcePath).toLowerCase();

    let data: ArrayBuffer | Buffer<ArrayBufferLike> | string | undefined;

    if (ext === ".js" || ext === ".ts") {
      const worker = new URLSearchParams(querystring).has("worker");

      if (worker) {
        const map = new Map([[resourcePath, resourceAlias]]);
        await processScript(replacers, map);
      }
    }

    else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
      data = await processImage(resourcePath, querystring);
    }

    else if (ext === ".css") {
      data = await processCss(replacers, resourcePath);
    }

    else {
      // unknown file extension
      return;
    }

    if (data) {
      const hash = generateHash(data);
      const { route, outPath } = generateRoute(resourcePath, hash);

      replacers.set(resourceAlias, route);

      await Bun.write(outPath, data);
    }
  }

  async function processScript(replacers: Map<string, string>, input: string | Map<string, string>) {
    const inline = typeof input === "string";
    const builder = await rolldown({
      input: inline ? input : Array.from(input.keys()),
      treeshake: true,
      optimization: {
        inlineConst: true,
      },
      plugins: [
        aliasPlugin({
          entries: [
            frontendAlias,
          ],
        }),

        {
          name: "x:bundle",
          transform: {
            async handler(code, id) {
              if (!id.includes(`/${frontendDir}/`)) {
                return;
              }

              for (const match of code.matchAll(resourceRegex)) {
                const resourceAlias = match[1] ?? "";

                if (replacers.has(resourceAlias)) {
                  continue;
                }

                const resourcePathAndQuery = resolveAlias(resourceAlias);

                if (resourcePathAndQuery) {
                  await processFile(replacers, resourceAlias, resourcePathAndQuery);
                }
              }

              let output = code;

              for (const [alias, filePath] of replacers) {
                output = output.replaceAll(alias, filePath);
              }

              return {
                code: output,
              };
            },
          },
        },
      ],
    });

    const result = await builder.write({
      dir: path.join(cwd, bundleDir, inline ? tempDir : assetsDir),
      format: "esm",
      minify: inline ? "dce-only" : true,
      sourcemap: !inline,
      hashCharacters: "base36",
      entryFileNames: "[name].[hash].js",
      chunkFileNames: "[name].[hash].js",
    });

    if (inline) {
      return result.output[0].code;
    }

    for (const chunk of result.output) {
      if (chunk.type === "chunk" && chunk.isEntry && chunk.facadeModuleId) {
        const resourceAlias = input.get(chunk.facadeModuleId);

        if (resourceAlias) {
          replacers.set(resourceAlias, `/${assetsDir}/${chunk.fileName}`);
        }
      }
    }
  }

  function formatFileSize(byteLength: number) {
    const KB = 1000;
    const MB = KB * 1000;

    if (byteLength >= MB) {
      return (byteLength / MB).toFixed(2) + " MB";
    }

    if (byteLength >= KB) {
      return (byteLength / KB).toFixed(1) + " KB";
    }

    return byteLength + " bytes";
  }

  function getColor(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case ".map": return "grey";
      case ".js": return "orange";
      case ".css": return "lime";
      case ".html": return "yellow";
      default: return "lightgrey";
    }
  }

  console.log(color("cornflowerblue", "===== bundle start ====="));

  const startTime = performance.now();

  rmSync(path.join(cwd, bundleDir), { force: true, recursive: true });

  const version = Date.now();

  const rawHTMLs = new Map<string, string>();
  const rawScripts = new Map<string, string>();

  const replacers = new Map<string, string>();

  for (const name of new Bun.Glob(`${templateDir}/**/*`).scanSync({ cwd: path.join(cwd, frontendDir) })) {
    const moduleExt = path.extname(name);
    const moduleTemp = path.join(cwd, bundleDir, tempDir, name.replace(moduleExt, `.${version}${moduleExt}`));

    const modulePath = path.join(cwd, frontendDir, name);
    const moduleBuild = await Bun.build({
      entrypoints: [modulePath],
      packages: 'bundle',
    });

    const moduleBuildOutput = moduleBuild.outputs[0];

    if (!moduleBuildOutput) {
      console.log(color("red", `can't process "${modulePath}"`));
      continue;
    }

    await Bun.write(moduleTemp, await moduleBuildOutput.text());

    const module = await import(moduleTemp);
    const html: string = module.default?.() ?? "";

    for (const match of html.matchAll(resourceRegex)) {
      const resourceAlias = match[1] ?? "";
      const resourcePathAndQuery = resolveAlias(resourceAlias);

      if (!resourcePathAndQuery) {
        continue;
      }

      const [resourcePath, querystring] = resourcePathAndQuery;
      const ext = path.extname(resourcePath).toLowerCase();

      if (ext === ".js" || ext === ".ts") {
        const inline = new URLSearchParams(querystring).has("inline");
        const key = inline ? match[0] : resourceAlias;

        if (replacers.has(key)) {
          continue;
        }

        if (inline) {
          const code = await processScript(replacers, resourcePath);

          if (typeof code === "string") {
            replacers.set(key, code);
          }
        }

        else {
          // collect and build together.
          rawScripts.set(resourcePath, resourceAlias);
        }
      }

      else {
        await processFile(replacers, resourceAlias, resourcePathAndQuery);
      }
    }

    rawHTMLs.set(name, html);
  }

  if (rawScripts.size > 0) {
    await processScript(replacers, rawScripts);
  }

  rmSync(path.join(cwd, bundleDir, tempDir), { force: true, recursive: true });

  const inlines: string[] = [];

  if (isAutoReload) {
    const codePath = path.join(__dirname, "inline-scripts/auto-reload.ts");
    const code = await Bun.file(codePath).text();

    inlines.push(`<script>${code}</script>`);
  }

  for (const [name, html] of rawHTMLs) {
    let output = html;

    for (const [alias, filePath] of replacers) {
      output = output.replaceAll(alias, filePath);
    }

    if (inlines.length) {
      output = output.replace("</head>", `${inlines.join("")}</head>`);
    }

    output = await prettier.format(output, prettierOptions);

    const outName = name.replace(path.extname(name), ".html");
    const outPath = path.join(cwd, bundleDir, outName);

    await Bun.write(outPath, output);
  }

  const endTime = performance.now();
  const usage = endTime - startTime;
  const [value, unit] = usage > 1000 ? [(usage / 1000).toFixed(1), "s"] : [usage.toFixed(0), "ms"];

  const root = path.join(cwd, bundleDir);
  const entries = Array.from(new Bun.Glob(`**/*`).scanSync({ cwd: root, dot: true }));

  entries.sort((a, b) => a.localeCompare(b));

  let maxLength = 0;

  for (const name of entries) {
    if (name.length > maxLength) {
      maxLength = name.length;
    }
  }

  for (const name of entries) {
    const data = await Bun.file(path.join(root, name)).arrayBuffer();
    const dataSize = `(${formatFileSize(data.byteLength)})`;

    console.log(color(getColor(name), `> ${name.padEnd(maxLength, " ")} ${dataSize}`));
  }

  console.log(color("cornflowerblue", `===== bundle end: (${value} ${unit}) =====`));
}

async function dev() {
  const autoReloadTopic = "auto_reload";

  let autoReloadRevision = 0;
  let autoReloadController = new AbortController();
  let autoReloadServer: Bun.Server | undefined;

  if (isAutoReload) {
    autoReloadServer = Bun.serve({
      hostname: "0.0.0.0",
      port: 7999,

      websocket: {
        open: (ws) => {
          // console.log("Client connected");
          ws.subscribe(autoReloadTopic);
        },

        message: (_ws, __message) => {
          // console.log("Client sent message", message);
        },

        close: (ws) => {
          // console.log("Client disconnected");
          ws.unsubscribe(autoReloadTopic);
        },
      },

      async fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req);

          if (!upgraded) {
            return new Response("Upgrade failed", { status: 400 });
          }
        }

        return new Response(null, { status: 404 });
      },
    });
  }

  async function ping() {
    const host = "localhost";
    const port = Number(process.env.PORT || 8080);
    const timeout = 1_000;

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();

        const onError = (err: Error) => {
          socket.destroy();
          reject(err);
        };

        socket.setTimeout(timeout);
        socket.once('error', onError);
        socket.once('timeout', () => onError(new Error(`Timeout trying to connect to ${host}:${port}`)));
        socket.connect(port, host, () => {
          socket.end();
          resolve();
        });
      });

      return true;
    } catch {
      return false;
    }
  }

  async function notify() {
    autoReloadController = new AbortController();
    const signal = autoReloadController.signal;

    while (!signal.aborted) {
      if (await ping()) {
        autoReloadServer?.publish(autoReloadTopic, `${autoReloadRevision++}`);
        break;
      }

      await Bun.sleep(1_000);
    }
  }

  function generateHash(file: string) {
    return `${file}:${Bun.hash(readFileSync(file, "binary")).toString(36)}`;
  }

  function generateHashes(dir: string) {
    const glob = new Bun.Glob(`${dir}/**/*`);
    const iter = glob.scanSync({ cwd, absolute: true, dot: true, onlyFiles: true });

    return Array.from(iter).map(generateHash);
  }

  let webServer: Bun.Subprocess<"ignore", "inherit", "inherit"> | undefined;

  let previousFrontend = new Set<string>();
  let previousBackend = new Set<string>();

  while (true) {
    await Bun.sleep(100);

    const nextFrontend = new Set([
      ...generateHashes(frontendDir),
    ]);

    const isFrontendChanged = nextFrontend.symmetricDifference(previousFrontend).size > 0;

    previousFrontend = nextFrontend;

    if (isFrontendChanged) {
      try {
        await bundle();
      } catch (err) {
        console.error(err);
      }
    }

    if (backendLanguage) {
      const nextBackend = new Set([
        ...generateHashes(bundleDir),
        ...generateHashes(backendDir),
      ]);

      const isBackendChanged = nextBackend.symmetricDifference(previousBackend).size > 0;

      previousBackend = nextBackend;

      if (isFrontendChanged || isBackendChanged) {
        autoReloadController?.abort();

        if (webServer) {
          webServer.kill("SIGINT");

          while (!webServer.killed) {
            await Bun.sleep(10);
          }

          console.log(color("cornflowerblue", "===== server end ====="));
        }

        console.log(color("cornflowerblue", "===== server start ====="));

        if (backendLanguage === "rust") {
          const cmd = ["cargo", "run"];

          if (isProduction) {
            cmd.push("--release");
          }

          webServer = Bun.spawn({
            cmd,
            stdout: "inherit",
          });
        }

        if (isAutoReload) {
          await notify();
        }
      }
    }
  }
}

if (command === "dev") {
  console.clear();
  await dev();
}

else if (command === "bundle") {
  await bundle();
}

else {
  console.log("no operation");
}
