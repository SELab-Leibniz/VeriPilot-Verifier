import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { applyJavaEnvironment, resolveJavaHome } from '../scripts/bench/arkts-java.mjs';

const home = name => path.resolve(path.sep, 'jdk', name);
const existing = (...names) => file => names.some(name => file === path.join(home(name), 'bin', 'java.exe'));
const resolve = (explicit, env, ...present) => resolveJavaHome({ explicit, env, exists: existing(...present), platform: 'win32', devEco: home('deveco') });

test('JDK resolution: option, RC_JAVA_HOME, an existing JAVA_HOME, then the DevEco runtime', () => {
  const env = { RC_JAVA_HOME: home('rc'), JAVA_HOME: home('inherited') };
  assert.deepEqual(resolve(home('option'), env, 'option', 'rc', 'inherited', 'deveco'),
    { javaHome: home('option'), source: 'option', java: path.join(home('option'), 'bin', 'java.exe') });
  assert.equal(resolve(undefined, env, 'rc', 'inherited', 'deveco').source, 'RC_JAVA_HOME');
  assert.equal(resolve(undefined, { JAVA_HOME: home('inherited') }, 'inherited', 'deveco').source, 'JAVA_HOME');
  assert.equal(resolve(undefined, { JAVA_HOME: home('stale') }, 'deveco').source, 'deveco');
  assert.equal(resolve(undefined, {}, 'deveco').javaHome, home('deveco'));
});

test('explicit JDK choices must be usable and an absent JDK is an error before any model request', () => {
  assert.throws(() => resolve(home('missing'), {}, 'deveco'), /from option has no java\.exe/u);
  assert.throws(() => resolve(undefined, { RC_JAVA_HOME: home('missing') }, 'deveco'), /from RC_JAVA_HOME/u);
  assert.throws(() => resolve(undefined, { JAVA_HOME: home('stale') }), /No JDK/u);
});

test('the business environment gets JAVA_HOME and the JDK bin first on PATH exactly once', () => {
  const bin = path.join(home('rc'), 'bin');
  const env = applyJavaEnvironment(home('rc'), { Path: [path.resolve(path.sep, 'tools'), bin.toUpperCase(), path.resolve(path.sep, 'git')].join(path.delimiter) });
  assert.deepEqual(Object.keys(env).sort(), ['JAVA_HOME', 'Path', 'RC_JAVA_HOME']);
  assert.deepEqual(env.Path.split(path.delimiter), [bin, path.resolve(path.sep, 'tools'), path.resolve(path.sep, 'git')]);
  assert.equal(env.JAVA_HOME, home('rc'));
  assert.equal(applyJavaEnvironment(home('rc'), {}).PATH, bin);
});
