import { ElectronAPI } from '@electron-toolkit/preload'
import type { JarvisBridge } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    jarvis: JarvisBridge
  }
}
