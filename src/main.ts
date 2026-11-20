// Lifecycle of an entry process against its env, as env/src/wire.ts spells the contract out: pick a
// free port, hand that port number to the env, then keep asking whether the trial has finished and
// leave with status 0 once it has. None of this is contest code — app.ts supplies the server the
// suite actually grades, and this file only drives the harness handshake around it.
//
//   1. The env's origin arrives in MAKEFUN_ENV_URL (http://store:8080 inside a trial container).
//      When that variable is empty there is no peer to speak to, so the process stops with status 1
//      straight away.
//   2. Build the app and listen(0) so the kernel hands back a free port. Port 8080 belongs to the
//      env; this process must never try to take it.
//   3. Announce the port by POSTing $MAKEFUN_ENV_URL/register with {"port": N}. The env combines the
//      caller's address with N into this entry's base URL and dials it from that point on. Whoever
//      registers first wins; a 409 says somebody else already did, which is not ours to undo, so
//      this process simply goes on waiting like any other.
//   4. Ask GET $MAKEFUN_ENV_URL/done until the answer is {"done": true}. The env replies right away
//      ({"done": false} for as long as the suite runs), so this is a repeated poll rather than one
//      request held open. Errors and slow answers are retried with a short exponential backoff; the
//      process does not leave before the env reports done.
//   5. Shut the server down and exit 0. The harness then stops the env, and the env is the side that
//      writes the export the scorer reads.
//
// The only module this file pulls in is its own server: no third-party package, no Node built-in,
// no model call.

import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Ceiling for a single register or done call before it counts as abandoned and gets retried. */
const CALL_TIMEOUT_MS = 30_000;
/** First gap between two retries, and the gap it climbs toward. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Gap to wait after `tries` failed calls: doubling from BACKOFF_FIRST_MS, never past the ceiling. */
function backoffFor(tries: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** Math.min(tries, 8));
}

/**
 * POST the bound port until the env takes it. A 200 is the ordinary answer; a 409 means an earlier
 * register already won and there is nothing here to repair. A 400 or 405 breaks the contract and ends
 * the program; anything else, network trouble included, is retried because the env may still be
 * coming up.
 */
async function announcePort(port: number): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
    } catch (failure) {
      if (failure instanceof Error && failure.message.startsWith('register answered HTTP ')) throw failure;
    }
    await pause(backoffFor(tries));
  }
}

/** Keep asking GET /done until the answer is {"done":true}; it never returns without that answer. */
async function pollUntilFinished(): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Either the env has not started answering or the poll ran out of time; not done, so ask again.
    }
    await pause(backoffFor(tries));
  }
}

/** Bind the port, announce it, then wait on the env: that is the whole life of the process. */
async function runLifecycle(): Promise<void> {
  const srv = createApp();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, () => resolve());
  });
  const boundAddr = srv.address();
  if (boundAddr === null || typeof boundAddr === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${boundAddr.port}\n`);

  await announcePort(boundAddr.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await pollUntilFinished();
  srv.close();
  process.stdout.write('[entry] done\n');
}

try {
  await runLifecycle();
  process.exit(0);
} catch (failure) {
  process.stderr.write(`[entry] ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exit(1);
}
