import { spawn } from 'node:child_process';

// stderr is only kept for diagnostics; `-v error` keeps it short, but a broken
// input must never grow it without bound.
const MAX_STDERR_LENGTH = 64 * 1024;

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface RunProcessOptions {
  timeoutMs: number;
}

export class ProcessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${timeoutMs} ms and was killed`);
    this.name = 'ProcessTimeoutError';
  }
}

// Runs a binary with an argument array and no shell, so URLs and file names are
// never interpreted. On timeout the process gets SIGKILL and the promise rejects.
// A process killed by a signal resolves with exitCode -1.
export function runProcess(
  command: string,
  args: string[],
  { timeoutMs }: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_LENGTH) {
        stderr = (stderr + chunk).slice(0, MAX_STDERR_LENGTH);
      }
    });

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProcessTimeoutError(command, timeoutMs));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr, exitCode: code ?? -1 });
    });
  });
}
