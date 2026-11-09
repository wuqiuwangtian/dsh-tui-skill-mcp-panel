import { checkManifest } from './release/manifest.mjs'

try {
  const report = await checkManifest()
  if (!process.argv.includes('--quiet')) console.log(JSON.stringify({ check: 'manifest', ok: true, ...report }, null, 2))
} catch (error) {
  console.error(`check:manifest failed: ${error.message}`)
  process.exitCode = 1
}
