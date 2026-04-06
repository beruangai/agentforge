/** Tool definition as seen by gateway clients (prefixed name) */
export interface GatewayTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
