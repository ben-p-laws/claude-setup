export type QueueItem = {
  id: string
  name: string
  type: string
  summary?: string
  install?: string[]
  [key: string]: unknown
}

export type QueueView = {
  pending: QueueItem[]
  busy: string | null
  message: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'setup-queue': { view: Shaped<QueueView> }
  }
}
