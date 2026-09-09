export function installShutdownHandlers(options: {
  label: string
  stop: () => Promise<void>
  watchStdin?: boolean
}): void {
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`${options.label}: shutting down\n`)
    void options.stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }

  if (options.watchStdin) {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
