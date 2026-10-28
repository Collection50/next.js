import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { retry } from 'next-test-utils'

jest.mock(
  'vitest',
  () => {
    const checks = new Map<string, () => Promise<void>>()
    return {
      __checks: checks,
      test: (name: string, body: () => Promise<void>) => checks.set(name, body),
      beforeAll: jest.fn(),
      afterAll: jest.fn(),
      expect,
      vi: {},
    }
  },
  { virtual: true }
)
jest.mock(
  '../../../evals/next-upgrade/apps/member-dashboard/behavior.spec',
  () => ({
    verifyBrowser: jest.fn(),
    verifyHttp: jest.fn(),
  })
)

const checks: Map<string, () => Promise<void>> =
  jest.requireMock('vitest').__checks
const {
  upgradeChecks,
}: {
  upgradeChecks(target: string): void
} = require('../../../evals/next-upgrade/verifier/upgrade')
let directory: string
let app: string
let report: string
const previousApp = process.env.NEXT_UPGRADE_VERIFY_APP
const previousReport = process.env.NEXT_UPGRADE_VERIFY_REPORT

beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'next-upgrade-verifier-'))
  )
  app = join(directory, 'app')
  report = join(directory, 'verification.json')
  const executable = join(app, 'node_modules/next/dist/bin/next')
  await fs.mkdir(dirname(executable), { recursive: true })
  await fs.writeFile(
    join(app, 'package.json'),
    JSON.stringify({ scripts: { build: 'next build' } })
  )
  process.env.NEXT_UPGRADE_VERIFY_APP = app
  process.env.NEXT_UPGRADE_VERIFY_REPORT = report
  checks.clear()
  upgradeChecks('15.5.24')
})

afterEach(async () => {
  if (previousApp === undefined) delete process.env.NEXT_UPGRADE_VERIFY_APP
  else process.env.NEXT_UPGRADE_VERIFY_APP = previousApp
  if (previousReport === undefined)
    delete process.env.NEXT_UPGRADE_VERIFY_REPORT
  else process.env.NEXT_UPGRADE_VERIFY_REPORT = previousReport
  await fs.rm(directory, { recursive: true, force: true })
})

it('keeps the verifier responsive while a build waits for external progress', async () => {
  const ready = join(directory, 'ready')
  const release = join(directory, 'release')
  await fs.writeFile(
    join(app, 'node_modules/next/dist/bin/next'),
    `
      const fs = require('node:fs')
      fs.writeFileSync(${JSON.stringify(ready)}, '')
      const interval = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) {
          clearInterval(interval)
          process.stdout.write(JSON.stringify({
            cwd: process.cwd(),
            environment: process.env.NODE_ENV,
            telemetry: process.env.NEXT_TELEMETRY_DISABLED,
            args: process.argv.slice(2),
          }))
        }
      }, 10)
      setTimeout(() => process.exit(2), 10000).unref()
    `
  )
  let settled = false
  const outcome = checks.get('build')!().then(
    () => {
      settled = true
      return { passed: true }
    },
    (error) => {
      settled = true
      return { passed: false, error }
    }
  )
  try {
    await retry(async () => {
      await expect(fs.stat(ready)).resolves.toBeDefined()
    })
    expect(settled).toBe(false)
    await fs.writeFile(release, '')
    expect(await outcome).toEqual({ passed: true })
    const result = JSON.parse(await fs.readFile(report, 'utf8'))
    expect(result.checks.build.passed).toBe(true)
    expect(JSON.parse(result.checks.build.evidence)).toEqual({
      cwd: app,
      environment: 'production',
      telemetry: '1',
      args: ['build'],
    })
  } finally {
    await fs.writeFile(release, '')
    await outcome
  }
})

it('fails verification when the build command fails', async () => {
  await fs.writeFile(
    join(app, 'node_modules/next/dist/bin/next'),
    "process.stderr.write('build failed'); process.exit(7)"
  )
  await expect(checks.get('build')!()).rejects.toMatchObject({ code: 7 })
  const result = JSON.parse(await fs.readFile(report, 'utf8'))
  expect(result.checks.build.passed).toBe(false)
  expect(result.checks.build.evidence).toContain('build failed')
})
