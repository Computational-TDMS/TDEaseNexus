/**
 * The one complete shell environment for agent-run commands.
 *
 * Both the synchronous `bash` tool and background jobs (`job.start`) run the
 * agent's bash-language commands and must see the SAME environment: the skill
 * runtime env (bundled uv on PATH, UV_*, TDEASE_SYSTEM_ASSETS), the managed
 * rg/fd bin dir, and the stable TDEASE_WORKSPACE anchor. Historically they
 * diverged — bash built the full env inline, jobs got only the bare runtime
 * env and ran under cmd.exe, so `$VAR` expansion and `TDEASE_WORKSPACE`
 * worked in bash but silently broke in jobs. One factory, both consumers.
 */
import path from 'node:path'
import fs from 'node:fs'

export function buildBashEnv(
  cwd: string,
  managedBinDir: string,
  systemAssetsRoot: string,
  resolveBashEnv: () => NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const runtime = resolveBashEnv()
  const inheritedPath = runtime.PATH ?? runtime.Path ?? ''
  const tempDir = path.join(cwd, '.tdease', 'tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  return {
    ...runtime,
    PATH: `${managedBinDir}${path.delimiter}${inheritedPath}`,
    TEMP: tempDir,
    TMP: tempDir,
    TDEASE_SYSTEM_ASSETS: systemAssetsRoot,
    // A stable anchor for the Workspace root, independent of per-call cwd.
    TDEASE_WORKSPACE: cwd,
  }
}
