import { ProcessTimeoutError, runProcess } from './process-runner';

describe('runProcess (integration)', () => {
  it('should collect stdout, stderr and the exit code of the process', async () => {
    const result = await runProcess(
      'sh',
      ['-c', 'printf out; printf err >&2; exit 3'],
      { timeoutMs: 5_000 },
    );

    expect(result.stdout.toString()).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.exitCode).toBe(3);
  });

  it('should pass arguments literally, without a shell', async () => {
    const argument = '$(echo injected); `id` | cat > /dev/null';

    const result = await runProcess('printf', ['%s', argument], {
      timeoutMs: 5_000,
    });

    expect(result.stdout.toString()).toBe(argument);
  });

  it('should kill the process and reject with ProcessTimeoutError on timeout', async () => {
    const startedAt = Date.now();

    await expect(
      runProcess('sleep', ['10'], { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('should reject when the binary does not exist', async () => {
    await expect(
      runProcess('binary-that-does-not-exist', [], { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
