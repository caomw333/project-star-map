import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectFile, readProjectMap } from './project-map.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const viewer = await readFile(new URL('./viewer.html', import.meta.url), 'utf8');
const output = process.argv[2];
const serve = output === '--serve';
const catalogPath = new URL('./projects.json', import.meta.url);
const cache = new Map();

async function projects() {
  const rows = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('Register at least one project');
  const ids = new Set();
  return rows.map(({ id, title, root }, index) => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id) ||
        typeof title !== 'string' || !title.trim() || typeof root !== 'string' || !root.trim()) {
      throw new Error(`Invalid project registration: ${id}`);
    }
    ids.add(id);
    return { id, title, root, href: index === 0 ? '/' : `/projects/${id}/` };
  });
}

async function loadMap(project, options) {
  const root = await realpath(resolve(here, project.root));
  let raw;
  try {
    raw = await readFile(await projectFile(root, 'flow/map.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = JSON.stringify([root, project.title, options, raw]);
  const cached = cache.get(project.id);
  if (cached?.key === key) return cached;
  const flow = raw === undefined ? {
    project: project.title, title: '等待发布第一张星图', summary: '项目 AI 发布流程图后，这里会自动显示。', phases: [], edges: [],
  } : await readProjectMap(raw, root);
  const targets = new Map();
  const base = project.href;
  if (serve) flow.live = { map: `${base}map`, proposal: `${base}proposal`, projects: options, current: base };
  for (const phase of flow.phases) {
    for (const step of phase.steps ?? []) {
      const file = await projectFile(root, step.file);
      step.editorUrl = `vscode://file${pathToFileURL(file).pathname}:${step.line}:1`;
      if (serve) {
        const target = `${file}:${step.line}:1`;
        const id = createHash('sha256').update(target).digest('hex');
        step.openUrl = `${base}open/${id}`;
        targets.set(id, target);
      }
    }
  }
  const data = JSON.stringify(flow).replaceAll('<', '\\u003c');
  const result = { key, data, targets, html: viewer.replace('__FLOW_MAP_DATA__', () => data) };
  cache.set(project.id, result);
  return result;
}

if (serve) {
  const editor = process.env.FLOW_EDITOR || (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
    : 'code');
  async function handle(request, response) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(403).end();
      return;
    }
    const pathname = new URL(request.url, origin).pathname;
    const scoped = /^\/projects\/([a-z0-9][a-z0-9-]*)(?:\/(.*))?$/.exec(pathname);
    const route = scoped ? `/${scoped[2] ?? ''}` : pathname;
    const rows = await projects();
    const project = scoped ? rows.find(({ id }) => id === scoped[1]) : rows[0];
    if (!project) return response.writeHead(404).end();
    const options = rows.map(({ title, href }) => ({ title, href }));
    if (request.method === 'GET' && ['/', '/map'].includes(route)) {
      const page = route === '/';
      const { data, html } = await loadMap(project, options);
      response.writeHead(200, {
        'content-type': page ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }).end(page ? html : data);
      return;
    }
    if (request.method === 'GET' && route === '/proposal') {
      const root = await realpath(resolve(here, project.root));
      const file = join(root, '.cache', 'flow', 'current.json');
      realpath(file).then((target) => {
        const normalize = process.platform === 'win32' ? (path) => path.toLowerCase() : (path) => path;
        if (normalize(target) !== normalize(file)) throw new Error('Unexpected proposal path');
        return readFile(target, 'utf8');
      }).then((body) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body);
      }).catch((error) => {
        response.writeHead(error.code === 'ENOENT' ? 200 : 500, { 'content-type': 'application/json' }).end('null');
      });
      return;
    }
    const match = /^\/open\/([a-f0-9]{64})$/.exec(route);
    if (request.method !== 'POST' || !match) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.origin !== origin) {
      response.writeHead(403).end();
      return;
    }
    const target = (await loadMap(project, options)).targets.get(match[1]);
    if (!target) {
      response.writeHead(404).end();
      return;
    }
    const child = spawn(editor, ['--reuse-window', '--goto', target], { detached: true, stdio: 'ignore' });
    child.once('error', () => response.writeHead(500).end());
    child.once('spawn', () => {
      child.unref();
      response.writeHead(204).end();
    });
  }
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error(error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(Number(process.argv[3] ?? 0), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
} else {
  const rows = await projects();
  const id = process.argv[3] ?? rows[0].id;
  const project = rows.find((row) => row.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  const { html } = await loadMap(project, []);
  if (output) {
    await writeFile(resolve(output), html, 'utf8');
    console.log(resolve(output));
  } else {
    process.stdout.write(html);
  }
}
