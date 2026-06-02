export type EventCallback = (event: unknown) => void

export const ConnectionState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  ERROR: 'ERROR',
} as const

export type ConnectionState = typeof ConnectionState[keyof typeof ConnectionState]

class AppSyncEventsService {
  private ws: WebSocket | null = null
  private httpEndpoint = ''
  private realtimeEndpoint = ''
  private apiKey = ''
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED
  private subscriptions = new Map<string, EventCallback[]>()
  private subscriptionIdToChannel = new Map<string, string>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stateCallbacks = new Set<(s: ConnectionState) => void>()

  configure(httpEndpoint: string, realtimeEndpoint: string, apiKey: string) {
    this.httpEndpoint = httpEndpoint
    this.realtimeEndpoint = realtimeEndpoint
    this.apiKey = apiKey
  }

  onStateChange(cb: (s: ConnectionState) => void) {
    this.stateCallbacks.add(cb)
    return () => this.stateCallbacks.delete(cb)
  }

  private setState(s: ConnectionState) {
    if (this.connectionState !== s) {
      this.connectionState = s
      this.stateCallbacks.forEach(cb => cb(s))
    }
  }

  private b64url(obj: unknown) {
    return btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionState === ConnectionState.CONNECTED) { resolve(); return }

      this.setState(ConnectionState.CONNECTING)
      const httpHost = new URL(this.httpEndpoint).host
      const authSubprotocol = `header-${this.b64url({ host: httpHost, 'x-api-key': this.apiKey })}`

      this.ws = new WebSocket(this.realtimeEndpoint, [authSubprotocol, 'aws-appsync-event-ws'])

      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({ type: 'connection_init' }))
      }

      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'connection_ack') {
          this.setState(ConnectionState.CONNECTED)
          this.startHeartbeat()
          this.resubscribeAll()
          resolve()
        } else if (msg.type === 'connection_error') {
          this.setState(ConnectionState.ERROR)
          reject(new Error(msg.errors?.[0]?.message ?? 'Connection error'))
        } else if (msg.type === 'data') {
          const channel = this.subscriptionIdToChannel.get(msg.id)
          if (channel) {
            const data = typeof msg.event === 'string' ? JSON.parse(msg.event) : msg.event
            this.subscriptions.get(channel)?.forEach(cb => cb(data))
          }
        }
      }

      this.ws.onerror = () => { this.setState(ConnectionState.ERROR); reject(new Error('WebSocket error')) }
      this.ws.onclose = () => { this.setState(ConnectionState.DISCONNECTED); this.stopHeartbeat() }
    })
  }

  private resubscribeAll() {
    this.subscriptions.forEach((_, ch) => this.sendSubscribe(ch))
  }

  private sendSubscribe(channel: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const httpHost = new URL(this.httpEndpoint).host
    this.subscriptionIdToChannel.set(id, channel)
    this.ws.send(JSON.stringify({
      type: 'subscribe', id,
      channel: channel.startsWith('/') ? channel : `/${channel}`,
      authorization: { host: httpHost, 'x-api-key': this.apiKey },
    }))
  }

  subscribe(channel: string, cb: EventCallback) {
    if (!this.subscriptions.has(channel)) this.subscriptions.set(channel, [])
    this.subscriptions.get(channel)!.push(cb)
    if (this.connectionState === ConnectionState.CONNECTED) this.sendSubscribe(channel)
    return () => {
      const cbs = this.subscriptions.get(channel)
      if (cbs) { const i = cbs.indexOf(cb); if (i !== -1) cbs.splice(i, 1) }
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) this.disconnect()
    }, 30_000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  disconnect() {
    this.stopHeartbeat()
    this.subscriptions.clear()
    this.subscriptionIdToChannel.clear()
    this.ws?.close()
    this.ws = null
    this.setState(ConnectionState.DISCONNECTED)
  }
}

export const appSyncEvents = new AppSyncEventsService()
