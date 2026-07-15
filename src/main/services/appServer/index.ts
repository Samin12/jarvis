import { JarvisAppServer, type AppServerClientOptions } from './client'
import { resolveBundledCodexExecutable, type CodexResolutionContext } from './executable'

export * from './client'
export * from './environment'
export * from './errors'
export * from './executable'
export * from './jsonLines'
export * from './permissions'
export * from './protocol'

export interface CreateJarvisAppServerOptions extends Omit<AppServerClientOptions, 'executable'> {
  resolution: CodexResolutionContext
}

/** Resolve the physical pinned binary before constructing the lifecycle client. */
export async function createJarvisAppServer(
  options: CreateJarvisAppServerOptions
): Promise<JarvisAppServer> {
  const { resolution, ...clientOptions } = options
  const executable = await resolveBundledCodexExecutable(resolution)
  return new JarvisAppServer({ ...clientOptions, executable })
}
