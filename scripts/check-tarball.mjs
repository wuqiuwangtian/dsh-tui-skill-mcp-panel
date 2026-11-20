import { checkTarball } from './release/tarball.mjs'

try {
  console.log(JSON.stringify({ check: 'tarball', ok: true, ...await checkTarball(undefined, process.argv[2]) }, null, 2))
} catch (error) {
  console.error(`check:tarball failed: ${error.message}`)
  process.exitCode = 1
}
