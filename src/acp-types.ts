/**
 * Local type definitions for ACP SDK interactions.
 * Provides type safety without relying on SDK exporting all types.
 */

export interface AcpInitializeParams {
  protocolVersion: number
  clientCapabilities: Record<string, unknown>
  clientInfo: { name: string; version: string }
}

export interface AcpInitializeResult {
  agentInfo?: { name?: string; version?: string }
}

export interface AcpNewSessionParams {
  cwd: string
  mcpServers: unknown[]
}

export interface AcpNewSessionResult {
  sessionId: string
  models?: { availableModels?: Array<{ modelId: string; name?: string }> }
}

export interface AcpPromptParams {
  sessionId: string
  prompt: Array<{ type: 'text'; text: string }>
}

export interface AcpPromptResult {
  stopReason?: string | null
}

export interface AcpPermissionOption {
  kind: string
  optionId: string
}

export interface AcpPermissionRequest {
  toolCall?: { title?: string }
  options?: AcpPermissionOption[]
}

export interface AcpSessionUpdate {
  sessionUpdate: string
  content?: { type?: string; text?: string }
  toolCallId?: string
  title?: string
  status?: string
  entries?: unknown[]
}
