// The bot workflows put their metadata in git trailers (scripts/commit-message.sh,
// scripts/sync-commit-message.sh). These check that git itself reads the
// trailers back, since that is the only reason to write them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const run = (script, args) => execFileSync(`scripts/${script}`, args, { encoding: 'utf8' })
const parse = msg => execFileSync('git', ['interpret-trailers', '--parse'], { input: msg, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)

test('commit-message.sh: subject, then the trailers git parses', () => {
  const msg = run('commit-message.sh', ['Add Unofficial link: Foo', 'Issue=#212', 'Content-Id=abc-123', 'Run=https://x/runs/1'])
  assert.equal(msg.split('\n')[0], 'Add Unofficial link: Foo')
  assert.deepEqual(parse(msg), ['Issue: #212', 'Content-Id: abc-123', 'Run: https://x/runs/1'])
})

test('commit-message.sh: empty values are left out, newlines folded', () => {
  const msg = run('commit-message.sh', ['Add link: two\nlines', 'Issue=', 'Content-Id=a\nb'])
  assert.equal(msg.split('\n')[0], 'Add link: two lines')
  assert.deepEqual(parse(msg), ['Content-Id: a b'])
})

test('commit-message.sh: no trailers gives a bare subject', () => {
  assert.equal(run('commit-message.sh', ['Update link: Foo']), 'Update link: Foo\n')
})

test('sync-commit-message.sh: counts in the subject, one Portal-Source per page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aflink-'))
  const stats = path.join(dir, 'stats.txt')
  fs.writeFileSync(stats, '1520 links total: 3 added, 0 changed, 2 deprecated, 0 back on the portal, 0 retired\n+ Foo (Bar)\n')
  const msg = run('sync-commit-message.sh', [stats, 'index:manageApplications,quicklinks:p44C', 'Payload-Digest=4529', 'Payload-Id='])
  assert.equal(msg.split('\n')[0], 'Portal sync of 2 pages: 3 added, 2 deprecated')
  assert.deepEqual(parse(msg), ['Portal-Source: index:manageApplications', 'Portal-Source: quicklinks:p44C', 'Payload-Digest: 4529'])

  fs.writeFileSync(stats, '10 links total: 0 added, 0 changed, 0 deprecated, 0 back on the portal, 0 retired\n')
  assert.equal(run('sync-commit-message.sh', [stats, 'index:a']).split('\n')[0], 'Portal sync of 1 page: no link changes')
  fs.rmSync(dir, { recursive: true })
})
