// Windows-only cleanup helper for the embedded-postgres test instances.
//
// embedded-postgres' stop() runs `taskkill /pid <postmaster> /f /t`, which
// reliably kills the postmaster but can leave its forkchild workers behind
// (the io_worker on Windows). The orphan inherits the postmaster's stdio
// pipes and listen socket, which keeps the test process alive long after
// teardown completes and hangs the whole `node --test` run.
//
// An orphan is any postgres.exe whose command line carries "--forkchild" and
// whose parent process no longer exists. Live instances — including the
// long-running dev database from `npm run db:up`, which uses the same
// binary — have a live parent process and are never touched.

import { execFileSync } from 'node:child_process';

/**
 * Kill orphaned embedded-postgres forkchild workers.
 * @returns {number} how many processes were killed (0 on non-Windows or error).
 */
export function killOrphanedEmbeddedPostgres() {
  if (process.platform !== 'win32') return 0;
  try {
    const script =
      '$alive = @(Get-Process | Select-Object -ExpandProperty Id); ' +
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'forkchild' -and " +
      '($alive -notcontains $_.ParentProcessId) } | ' +
      'Select-Object -ExpandProperty ProcessId';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
    });
    let killed = 0;
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      try {
        execFileSync('taskkill', ['/PID', pid, '/F']);
        killed += 1;
      } catch {
        // the process may have exited in the meantime
      }
    }
    return killed;
  } catch {
    return 0; // best effort — teardown itself must not fail because of this
  }
}
