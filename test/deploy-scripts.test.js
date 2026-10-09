// P9 W3: the deployment files (deploy/). The SSH entry point accepts only its
// grammar; every script parses; the units run files that exist and read the
// paths setup.sh creates; setup writes every setting the app reads in
// production. shellcheck runs in CI (.github/workflows/test.yml).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const D = path.join(ROOT, 'deploy');
const read = f => fs.readFileSync(path.join(D, f), 'utf8');
const scripts = ['setup.sh', 'deploy.sh', ...fs.readdirSync(path.join(D, 'bin')).map(f => `bin/${f}`)];

function wrapper(command) {
  const r = spawnSync('bash', [path.join(D, 'bin', 'vantage-deploy')], {
    env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: command, VANTAGE_DEPLOY_DRY_RUN: '1' },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}

test('every deploy script parses and is executable', () => {
  for (const f of scripts) {
    const r = spawnSync('bash', ['-n', path.join(D, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    if (f.startsWith('bin/') || f === 'deploy.sh') assert.ok(fs.statSync(path.join(D, f)).mode & 0o111, `${f} +x`);
  }
});

test('the deploy key runs only "deploy <target> <ref>" and "status <target>"', () => {
  const sha = 'a'.repeat(40);
  for (const ok of [
    'deploy production main',
    'deploy staging staging',
    'deploy production rollback',
    `deploy staging ${sha}`,
    'status production',
  ])
    assert.deepEqual(wrapper(ok), { code: 0, out: ok }, ok);
  for (const bad of [
    '', // an interactive login
    'bash',
    'deploy production main; rm -rf /',
    'deploy production $(id)',
    'deploy production `id`',
    'deploy production main && id',
    'deploy production main extra',
    'deploy prod main',
    'deploy production HEAD~1',
    `deploy production ${sha.slice(1)}`, // not a full sha
    `deploy production ${'A'.repeat(40)}`, // not lowercase hex
    'deploy production',
    'status production main',
    'scp -t /tmp',
  ]) {
    const r = wrapper(bad);
    assert.equal(r.code, 2, `${JSON.stringify(bad)} -> ${r.out}`);
    assert.match(r.out, /^vantage-deploy: /);
  }
});

test('the systemd units run scripts that exist, from the release link, as the vantage user', () => {
  const units = fs.readdirSync(path.join(D, 'systemd'));
  assert.deepEqual(units.sort(), [
    'vantage-autodeploy.service',
    'vantage-autodeploy.timer',
    'vantage-duckdns.service',
    'vantage-duckdns.timer',
    'vantage-monthly.service',
    'vantage-monthly.timer',
    'vantage-nightly.service',
    'vantage-nightly.timer',
    'vantage-staging.service',
    'vantage@.service',
  ]);
  // the direct edge's helpers run installed scripts, as vantage
  for (const [u, bin] of [
    ['vantage-autodeploy.service', 'vantage-autodeploy production'],
    ['vantage-duckdns.service', 'vantage-duckdns'],
  ]) {
    const s = read(`systemd/${u}`);
    assert.match(s, /^User=vantage$/m, u);
    assert.match(s, new RegExp(`^ExecStart=/usr/local/bin/${bin}$`, 'm'), u);
    assert.ok(fs.existsSync(path.join(D, 'bin', bin.split(' ')[0])), `${u}: deploy/bin/${bin}`);
  }
  for (const u of units.filter(f => f.endsWith('.service') && !/autodeploy|duckdns/.test(f))) {
    const s = read(`systemd/${u}`);
    assert.match(s, /^User=vantage$/m, u);
    assert.match(s, /^EnvironmentFile=\/etc\/vantage\/vantage\.env$/m, u);
    assert.match(s, /^ProtectSystem=strict$/m, u);
    const exec = /^ExecStart=\/usr\/bin\/node \/opt\/vantage\/(prod|staging)\/current\/(.+)$/m.exec(s);
    assert.ok(exec, `${u} runs node from a current release`);
    assert.ok(fs.existsSync(path.join(ROOT, exec[2])), `${u}: ${exec[2]} exists`);
  }
  // deploy.sh restarts exactly what sudoers allows, with the same paths
  const sudo = /vantage ALL=\(root\) NOPASSWD: (.+)/.exec(read('setup.sh'))[1].split(', ');
  assert.deepEqual(sudo, [
    '/usr/bin/systemctl restart vantage@3002',
    '/usr/bin/systemctl restart vantage@3003',
    '/usr/bin/systemctl restart vantage-staging',
  ]);
  assert.match(read('deploy.sh'), /sudo \/usr\/bin\/systemctl restart "\$\{UNITS\[\$i\]\}"/);
  assert.match(read('deploy.sh'), /UNITS=\(vantage@3003 vantage@3002\)/);
});

test('Caddy, the tunnel and deploy.sh agree on ports; setup writes every production setting the app reads', () => {
  const caddy = read('Caddyfile');
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3002 127\.0\.0\.1:3003/);
  assert.match(caddy, /health_uri \/readyz/);
  assert.match(caddy, /bind 127\.0\.0\.1/);
  assert.match(caddy, /client_ip_headers CF-Connecting-IP/);
  const tunnel = read('cloudflared.yml');
  assert.match(tunnel, /service: http:\/\/127\.0\.0\.1:8080/);
  assert.match(tunnel, /service: http:\/\/127\.0\.0\.1:3010/);
  assert.match(tunnel, /- service: http_status:404\s*$/);
  assert.match(read('deploy.sh'), /SMOKE_URL=\$\{VANTAGE_DEPLOY_SMOKE_URL:-http:\/\/127\.0\.0\.1:8080\}/);
  const setup = read('setup.sh');
  for (const key of [
    'NODE_ENV="production"',
    'HOST="127.0.0.1"',
    'TRUST_PROXY="1"',
    'VANTAGE_PUBLIC="1"',
    'SEC_USER_AGENT=',
    'WAREHOUSE_DB_PATH=',
    'VANTAGE_BACKUP_DIR=',
    'VANTAGE_OFFSITE_CMD="$OFFSITE"',
    'OFFSITE=/usr/local/bin/vantage-offsite',
    'VANTAGE_ALERT_URL=',
    'VANTAGE_PUBLIC_URL=',
    'VANTAGE_SMOKE_URL="http://127.0.0.1:8080"',
    'VANTAGE_CDN_MAX_AGE="$CDN_MAX_AGE"',
  ])
    assert.ok(setup.includes(key), key);
  assert.ok(!/VANTAGE_ADMIN/.test(setup), 'admin actions are never on on the server');
  // every variable the app reads that setup writes is documented for local use too
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const k of [
    'VANTAGE_PUBLIC',
    'VANTAGE_CDN_MAX_AGE',
    'VANTAGE_OFFSITE_CMD',
    'VANTAGE_PUBLIC_URL',
    'VANTAGE_SMOKE_URL',
  ])
    assert.ok(example.includes(k), `.env.example documents ${k}`);
});

test('the direct edge: Caddy serves HTTPS for the name itself and trusts no forwarded header; setup opens 80/443', () => {
  const caddy = read('Caddyfile.direct');
  assert.match(caddy, /^__DOMAIN__ \{$/m, 'a site block for the name (automatic HTTPS)');
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3002 127\.0\.0\.1:3003/);
  assert.match(caddy, /health_uri \/readyz/);
  assert.match(caddy, /header_up X-Forwarded-For \{client_ip\}/);
  assert.doesNotMatch(caddy, /client_ip_headers|trusted_proxies/, 'no proxy in front: never trust a client header');
  assert.match(caddy, /http:\/\/:8080 \{\s*bind 127\.0\.0\.1/, 'the loopback listener the smoke checks use');
  assert.match(caddy, /encode zstd gzip/);
  const setup = read('setup.sh');
  assert.match(setup, /CADDYFILE=\$SRC\/Caddyfile\.direct/);
  assert.match(setup, /for port in 80 443; do/);
  assert.match(setup, /systemctl enable vantage-autodeploy\.timer vantage-duckdns\.timer/);
  assert.match(setup, /DUCKDNS_TOKEN="\$DUCKDNS"/);
  assert.match(setup, /sudo -u vantage git -C "\$APP\/repo" show/, 'git show as the repository owner');
  // auto-deploy needs a green Test run of that exact commit, and remembers a failed one
  const auto = read('bin/vantage-autodeploy');
  assert.match(auto, /select\(\.name == "Test" and \.head_sha == \$sha and \.conclusion == "success"\)/);
  assert.match(auto, /autodeploy-failed-\$TARGET/);
});

test('releases install the build tools whatever NODE_ENV the caller has (auto-deploy runs with production)', () => {
  const d = read('deploy.sh');
  const installs = d.match(/npm ci [^)]*/g);
  assert.equal(installs.length, 2);
  for (const i of installs) assert.match(i, /--include=dev/, i);
});
