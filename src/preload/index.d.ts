import type { JarvisBridge } from './index'

declare global {
  interface Window {
    jarvis: JarvisBridge
  }
}
