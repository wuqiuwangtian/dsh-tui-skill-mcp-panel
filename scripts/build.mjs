/** tsc does not remove orphaned output; clean only this project's generated type/JS tree. */
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await rm(resolve(root, 'lib/types'), { recursive: true, force: true })
execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
