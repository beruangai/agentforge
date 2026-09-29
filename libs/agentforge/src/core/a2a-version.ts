/**
 * The header a request names its A2A protocol version in, and the one version
 * AgentForge speaks (ADR 0014): sent by the client, allowlisted by the
 * construct so AgentCore forwards it, declared on the server's card. Imports
 * nothing, so the construct pulls in nothing with it.
 */
export const A2A_VERSION_HEADER = 'A2A-Version';
export const A2A_PROTOCOL_VERSION = '1.0';
