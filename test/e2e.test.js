'use strict';

const assert = require('node:assert/strict');
const { describe, test, before, after } = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'teardown');
const { parseSize, formatSize, sanitizeProject, nameMatches, parseSelection, worktreeVerdict, pickerStep, pickerLines } = require(TOOL);

const RUN = `tdtest-${crypto.randomBytes(4).toString('hex')}`;
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'teardown test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'teardown test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

let tmp;
let main;

function sh(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd: cwd || tmp, env: FIXTURE_GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function teardown(...args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: tmp,
    env: { ...process.env, TEARDOWN_ROOTS: tmp },
    input: '',
    encoding: 'utf8',
  });
}

function dockerList(kind, project) {
  const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
  return sh('docker', [...args, '--filter', `label=com.docker.compose.project=${project}`]).trim().split('\n').filter(Boolean);
}

function resources(project) {
  return {
    containers: dockerList('container', project).length,
    networks: dockerList('network', project).length,
    volumes: dockerList('volume', project).length,
    images: dockerList('image', project).length,
  };
}

function makeWorktree(name, { project, push = true } = {}) {
  const dir = path.join(tmp, name);
  sh('git', ['-C', main, 'worktree', 'add', '-q', '-b', name, dir]);
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM busybox\nCMD ["sleep", "3600"]\n');
  fs.writeFileSync(
    path.join(dir, 'compose.yaml'),
    'services:\n  app:\n    build: .\n    stop_signal: SIGKILL\n    volumes:\n      - data:/data\nvolumes:\n  data:\n',
  );
  sh('git', ['-C', dir, 'add', '.']);
  sh('git', ['-C', dir, 'commit', '-q', '-m', name]);
  if (push) sh('git', ['-C', dir, 'push', '-q', '-u', 'origin', name]);
  if (project) sh('docker', ['compose', '-p', project, 'up', '-d', '--build', '--quiet-pull'], dir);
  return dir;
}

function stop(project, dir) {
  sh('docker', ['compose', '-p', project, 'stop'], dir);
}

function removeTestDockerResources() {
  const label = 'com.docker.compose.project';
  const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const ours = (rows) => rows.filter(([, project]) => project && project.startsWith(RUN)).map(([id]) => id);
  const labelled = (args, idField) =>
    docker([...args, '--filter', `label=${label}`, '--format', `{{.${idField}}}\t{{.Label "${label}"}}`]).map((row) => row.split('\t'));
  const images = docker(['image', 'ls', '-q', '--no-trunc', '--filter', `label=${label}`]).map((id) => [
    id,
    docker(['image', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, id])[0],
  ]);

  const containerIds = ours(labelled(['ps', '-a'], 'ID'));
  if (containerIds.length) spawnSync('docker', ['rm', '-f', '-v', ...containerIds]);
  const networkIds = ours(labelled(['network', 'ls'], 'ID'));
  if (networkIds.length) spawnSync('docker', ['network', 'rm', ...networkIds]);
  const volumeNames = ours(labelled(['volume', 'ls'], 'Name'));
  if (volumeNames.length) spawnSync('docker', ['volume', 'rm', ...volumeNames]);
  const imageIds = ours(images);
  if (imageIds.length) spawnSync('docker', ['image', 'rm', '-f', ...imageIds]);
}

describe('pure functions', () => {
  test('parseSize reads docker sizes in decimal units', () => {
    assert.equal(parseSize('132.7MB'), 132_700_000);
    assert.equal(parseSize('959.7kB'), 959_700);
    assert.equal(parseSize('68B'), 68);
    assert.equal(parseSize('1.2GB'), 1_200_000_000);
    assert.equal(parseSize('N/A'), 0);
  });

  test('formatSize prints human-readable sizes', () => {
    assert.equal(formatSize(68), '68 B');
    assert.equal(formatSize(132_700_000), '132.7 MB');
    assert.equal(formatSize(959_700), '959.7 kB');
    assert.equal(formatSize(999_990), '1.0 MB');
  });

  test('sanitizeProject follows compose project naming', () => {
    assert.equal(sanitizeProject('My.App'), 'myapp');
    assert.equal(sanitizeProject('_x-1'), 'x-1');
  });

  test('nameMatches accepts the folder name and prefixed hashed names only', () => {
    assert.ok(nameMatches('shop-shop-feat-9-7e37f4dfb8', '/w/shop-feat-9'));
    assert.ok(nameMatches('chat-api', '/w/chat-api'));
    assert.ok(nameMatches('shop-feat-9-7e37f4', '/w/shop-feat-9'));
    assert.ok(!nameMatches('shop-shop-feat-45-locks-4d826bdb4a', '/w/shop-feat-45'));
    assert.ok(!nameMatches('shop-shop-feat-9-7e37f', '/w/shop-feat-9'));
    assert.ok(!nameMatches('xshop-feat-9-7e37f4dfb8', '/w/shop-feat-9'));
    assert.ok(!nameMatches('chat-api-2', '/w/chat-api'));
  });

  test('worktreeVerdict applies the precedence', () => {
    const facts = { running: false, dirty: false, merged: false, onRemote: true };
    assert.equal(worktreeVerdict(facts).kind, 'open');
    assert.equal(worktreeVerdict({ ...facts, onRemote: false }).kind, 'unpushed');
    assert.equal(worktreeVerdict({ ...facts, merged: true }).kind, 'merged');
    assert.equal(worktreeVerdict({ ...facts, merged: true, dirty: true }).kind, 'dirty');
    assert.equal(worktreeVerdict({ ...facts, dirty: true, running: true }).kind, 'running');
  });

  test('pickerStep moves within the rows and toggles the row under the cursor', () => {
    const start = { cursor: 0, checked: [true, false] };
    assert.deepEqual(pickerStep(start, '\x1b[A'), start);
    const down = pickerStep(start, '\x1b[B');
    assert.equal(down.cursor, 1);
    assert.equal(pickerStep(down, '\x1b[B').cursor, 1);
    assert.deepEqual(pickerStep(down, ' ').checked, [true, true]);
    assert.deepEqual(pickerStep(start, ' ').checked, [false, false]);
  });

  test('pickerLines fits the terminal and totals the selected rows', () => {
    const texts = ['one', 'two', 'three', 'four', 'a row that is far too long for the terminal'];
    const state = { cursor: 4, checked: [true, false, true, false, false] };
    const out = pickerLines(texts, [1000, 5, 2000, 5, 5], state, 20, 5);
    assert.equal(out.length, 5);
    assert.ok(out.every((line) => line.length <= 19));
    assert.equal(out[3], '> [ ]  a row that i');
    assert.equal(out[1], '  [x]  three');
    assert.match(out[4], /^2 selected, 3\.0 kB/);
  });

  test('parseSelection honours the pre-marks and blocked rows', () => {
    const kinds = ['merged', 'dirty', 'open', 'folder-gone'];
    assert.deepEqual(parseSelection('', kinds, false), { indices: [0, 3] });
    assert.deepEqual(parseSelection('n', kinds, false), { indices: [] });
    assert.deepEqual(parseSelection('3, 1', kinds, false), { indices: [2, 0] });
    assert.match(parseSelection('2', kinds, false).error, /--force/);
    assert.deepEqual(parseSelection('2', kinds, true), { indices: [1] });
    assert.match(parseSelection('7', kinds, false).error, /not a row number/);
  });
});

describe('teardown against real git and docker', { concurrency: false }, () => {
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-test-')));
    main = path.join(tmp, 'main');
    sh('git', ['init', '-q', '--bare', '-b', 'main', path.join(tmp, 'origin.git')]);
    sh('git', ['clone', '-q', path.join(tmp, 'origin.git'), main]);
    fs.writeFileSync(path.join(main, 'README'), 'fixture\n');
    sh('git', ['-C', main, 'add', '.']);
    sh('git', ['-C', main, 'commit', '-q', '-m', 'init']);
    sh('git', ['-C', main, 'push', '-q', '-u', 'origin', 'main']);
    sh('git', ['-C', main, 'remote', 'set-head', 'origin', 'main']);
    sh('docker', ['pull', '-q', 'busybox']);
  });

  after(() => {
    removeTestDockerResources();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('removes a stopped stack and its worktree, and leaves a running neighbour alone', () => {
    const a = `${RUN}-a`;
    const b = `${RUN}-b`;
    const dirA = makeWorktree(a, { project: a });
    makeWorktree(b, { project: b });
    stop(a, dirA);

    const dry = teardown(dirA, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`volume\\s+${a}_data`));
    assert.match(dry.stdout, /total/);
    assert.deepEqual(resources(a), { containers: 1, networks: 1, volumes: 1, images: 1 }, 'dry run deleted nothing');
    assert.ok(fs.existsSync(dirA), 'dry run kept the folder');

    const result = teardown(dirA, '--yes');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(resources(a), { containers: 0, networks: 0, volumes: 0, images: 0 });
    assert.ok(!fs.existsSync(dirA), 'folder removed');
    assert.ok(!sh('git', ['-C', main, 'worktree', 'list']).includes(dirA), 'worktree unregistered');
    assert.ok(sh('git', ['-C', main, 'branch', '--list', a]).includes(a), 'branch kept');

    assert.deepEqual(resources(b), { containers: 1, networks: 1, volumes: 1, images: 1 }, 'neighbour stack kept');
    assert.equal(sh('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${b}`]).trim().split('\n').filter(Boolean).length, 1, 'neighbour still running');
    assert.equal(spawnSync('docker', ['image', 'inspect', 'busybox']).status, 0, 'pulled base image kept');

    const again = teardown(dirA, '--yes');
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /does not exist/);
    assert.doesNotMatch(again.stderr, /\n\s+at /);
  });

  test('refuses a running stack unless forced', () => {
    const c = `${RUN}-c`;
    const dir = makeWorktree(c, { project: c });

    const refused = teardown(dir, '--yes');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /running/);
    assert.match(refused.stderr, /--force/);
    assert.deepEqual(resources(c), { containers: 1, networks: 1, volumes: 1, images: 1 });
    assert.ok(fs.existsSync(dir));

    const forced = teardown(dir, '--force', '--yes');
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(resources(c), { containers: 0, networks: 0, volumes: 0, images: 0 });
    assert.ok(!fs.existsSync(dir));
  });

  test('refuses dirty, unpushed and main checkouts and deletes nothing', () => {
    const d = `${RUN}-d`;
    const dirD = makeWorktree(d, { project: d });
    stop(d, dirD);
    fs.writeFileSync(path.join(dirD, 'scratch.txt'), 'work in progress\n');
    const dirty = teardown(dirD, '--yes');
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /1 uncommitted file that would be lost/);
    assert.deepEqual(resources(d), { containers: 1, networks: 1, volumes: 1, images: 1 });
    assert.ok(fs.existsSync(path.join(dirD, 'scratch.txt')));

    const dirE = makeWorktree(`${RUN}-e`, { push: false });
    const unpushed = teardown(dirE, '--yes');
    assert.notEqual(unpushed.status, 0);
    assert.match(unpushed.stderr, /1 commit that exists only on this machine/);
    assert.ok(fs.existsSync(dirE));

    const mainCheckout = teardown(main, '--yes', '--force');
    assert.notEqual(mainCheckout.status, 0);
    assert.match(mainCheckout.stderr, /main checkout/);
    assert.ok(fs.existsSync(path.join(main, 'README')));
  });

  test('refuses a worktree whose git state cannot be read', () => {
    const dir = makeWorktree(`${RUN}-unreadable`);
    const index = path.resolve(dir, sh('git', ['-C', dir, 'rev-parse', '--git-path', 'index']).trim());
    fs.writeFileSync(index, 'broken');

    const refused = teardown(dir, '--yes');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /git status failed/);
    assert.ok(fs.existsSync(dir));
  });

  test('sweep never lists the main checkout when the root is spelled in another letter case', (t) => {
    const shouted = tmp.toUpperCase();
    if (!fs.existsSync(shouted)) return t.skip('the file system is case-sensitive');
    const swept = spawnSync(process.execPath, [TOOL, 'sweep', '--dry-run', '--no-fetch', '--keep-build-cache'], {
      cwd: tmp,
      env: { ...process.env, TEARDOWN_ROOTS: shouted },
      input: '',
      encoding: 'utf8',
    });
    assert.equal(swept.status, 0, swept.stderr);
    assert.ok(!swept.stdout.split('\n').some((line) => line.includes(`${main}  `) || line.endsWith(main)), swept.stdout);
  });

  test('finds the volume of a stack taken down with compose down by its name', () => {
    const folder = `${RUN}-g`;
    const project = `${RUN}-${folder}-0a1b2c3d4e`;
    const dir = makeWorktree(folder, { project });
    sh('docker', ['compose', '-p', project, 'down'], dir);
    assert.deepEqual(resources(project), { containers: 0, networks: 0, volumes: 1, images: 1 });

    const result = teardown(dir, '--yes');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(matched by name\)/);
    assert.deepEqual(resources(project), { containers: 0, networks: 0, volumes: 0, images: 0 });
    assert.ok(!fs.existsSync(dir));
  });

  test('sweep removes the pre-marked folder-gone and merged rows and keeps open ones', () => {
    const prefix = `${RUN}-sweep`;
    const gone = `${prefix}-gone`;
    const merged = `${prefix}-merged`;
    const open = `${prefix}-open`;

    const dirGone = makeWorktree(gone, { project: gone });
    stop(gone, dirGone);
    fs.rmSync(dirGone, { recursive: true, force: true });

    const dirMerged = makeWorktree(merged, { project: merged });
    stop(merged, dirMerged);
    sh('git', ['-C', main, 'merge', '-q', '--no-edit', merged]);
    sh('git', ['-C', main, 'push', '-q', 'origin', 'main']);

    const dirOpen = makeWorktree(open);

    const result = teardown('sweep', prefix, '--no-fetch', '--keep-build-cache', '--yes');
    assert.equal(result.status, 0, result.stderr);
    const row = (text) => result.stdout.split('\n').find((l) => l.includes(text) && /^\s*\d+\s/.test(l));
    assert.match(row(gone), /\[x\]\s+folder gone/);
    assert.match(row(dirMerged), /\[x\]\s+merged/);
    assert.match(row(dirOpen), /\[ \]\s+open/);
    assert.doesNotMatch(result.stdout, /Docker build cache/);

    assert.deepEqual(resources(gone), { containers: 0, networks: 0, volumes: 0, images: 0 });
    assert.deepEqual(resources(merged), { containers: 0, networks: 0, volumes: 0, images: 0 });
    assert.ok(!fs.existsSync(dirMerged));
    assert.ok(fs.existsSync(dirOpen));
  });
});
