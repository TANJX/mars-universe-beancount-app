// Lets `node --test` run the runway engine from source: Node strips the
// TypeScript types itself, and this hook retries extensionless relative
// imports ("./schedule") as "./schedule.ts", the way the bundler resolves
// them.
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context)
      throw err
    }
  },
})
